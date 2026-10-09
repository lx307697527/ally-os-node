import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import CheckIcon from '../components/CheckIcon.jsx';
import IClosedInlineEmbed from '../components/IClosedInlineEmbed.jsx';
import VidalyticsVideo from '../components/VidalyticsVideo.jsx';
import { handOverBookedCall } from '../lib/bookedCall.js';
import { consultationUrl, iclosedPassthroughParams } from '../lib/iclosedBooking.js';
import { trackCtaClick } from '../lib/workWithUsAnalytics.js';
import { WORK_WITH_US_VSL } from '../lib/vidalytics.js';
import { FAQS } from '../data/workWithUsFaqs.js';

import certCgmp from '../assets/images/work-with-us/cert-cgmp.webp';
import certFda from '../assets/images/work-with-us/cert-fda.webp';
import certNsf from '../assets/images/work-with-us/cert-nsf.webp';
import certUsa from '../assets/images/work-with-us/cert-usa.webp';
import facilityCorridor from '../assets/images/work-with-us/facility-corridor.webp';
import encapsulationMachine from '../assets/images/work-with-us/encapsulation-machine.webp';
import teamGroup from '../assets/images/work-with-us/team-group.webp';
import formatCapsules from '../assets/images/work-with-us/format-capsules.webp';
import formatSachets from '../assets/images/work-with-us/format-sachets.webp';
import formatStickPacks from '../assets/images/work-with-us/format-stick-packs.webp';
import formatPouches from '../assets/images/work-with-us/format-pouches.webp';
import formatTubs from '../assets/images/work-with-us/format-tubs.webp';
import fdaRegistration from '../assets/images/work-with-us/fda-registration.webp';
// The NSF certificate is NOT imported from `work-with-us/` [#3870]. The legacy
// page's `assets/certs/nsf-cert-v2.webp` and this file are the SAME document —
// certificate C0871161-HSCDS-1, printed 06 January 2026, expiring 13 January
// 2027 — and this one was already in the repo, rendered by the /certifications
// popup. Importing the legacy copy would have put the same certificate in the
// tree twice, which is how a renewal gets applied to one of them and not the
// other.
import nsfCertificate from '../assets/images/nsf-certificate.jpg';
// The same white mark the site Footer renders (783x627, the legacy page's
// 870x700 logo at the same aspect ratio). One file, not a second copy.
import logoWhite from '../assets/images/logo-white.png';

// [#3556, restyled #3870] The "Come Work With Us" ad landing page, rebuilt from
// the legacy standalone page (ally-nutra `public/lp/index.html`, live since
// 2026-08-10).
//
// ⚠️ IT IS NOT IN THE NAVIGATION, and that is the point rather than an
// oversight: Dasi commissioned it 2026-08-08 as a destination for paid ads and
// privately shared links. Header and Footer must not link to it, and
// `__tests__/WorkWithUs.test.js` asserts they do not.
//
// ⚠️ AND SINCE [FEAT-589 / #3902] THE NAVIGATION IS NOT ON IT EITHER. The
// legacy page has no header — content starts at `<body>` — and a footer of
// three items: the white logo, two policy links and a copyright line. An ad
// destination offers the visitor no in-site link that leads away from the
// booking flow. `Layout` in App.jsx skips the site Header and Footer for this
// page (keyed on `CHROMELESS_KEYS` in lib/pages.js), and the minimal footer is
// the last block of this view. The two links open this app's own
// `/privacy-policy` and `/terms-of-service` in a new tab, as in-app `Link`s so
// the role prefix survives them — never an absolute URL to another deployment.
//
// The eight sections are the legacy page's, in its order, with its copy carried
// over. What does NOT come over is the legacy `_ds/` stylesheet — this app's own
// classes and tokens render them, per #3870.
//
// ⚠️ EVERY CLASS HERE MUST BE DEFINED IN `styles/global.css`. The first cut of
// this view (#3640) used six classes — `wwu`, `wwu-hero`, `wwu-vsl`,
// `wwu-stats`, `wwu-cta`, `wwu-eyebrow` — that no stylesheet defined, and a
// browser answers an unresolvable class with silence, so the page rendered as
// unstyled document flow with every test still green. The suite now reads both
// sides (`every class the view uses is a class a stylesheet defines`), and that
// check can only see LITERAL `className="…"` strings — so do not compute one.
//
// ⚠️ TWO FACTS LIVE OUTSIDE THIS FILE, ONE PER MODULE:
//   * the VSL's two tiers — `lib/workWithUsMedia.js`, one exported list. [BUG-417]
//     closed the hosting question on 2026-09-21 by bundling the same files Home.jsx
//     plays; before that this view rendered a player with no sources at all;
//   * the CTA click event — `lib/workWithUsAnalytics.js`. The campaign's own Meta
//     dataset (2529780757518815) is NOT started here any more: since [FEAT-839] the
//     HubSpot tracking code loads it on every page (`public/shared/tracking.js`), and
//     starting it here as well would count this page twice.
//
// ⚠️ [FEAT-839] THIS VIEW SERVES TWO ADDRESSES. `/work-with-us` is the CONTROL of a
// Meta A/B test and renders with every default below — its content must not change.
// `/work-with-us-b` (`WorkWithUsB.jsx`) passes the props that differ: headline,
// subheadline, a pricing line above the booking form, its FAQ answers, its own
// iClosed event, and UTM passthrough into that event. Everything else is shared, so
// a fix to a section lands on both pages at once.

const HERO_CHIPS = [
  'NSF cGMP Certified',
  'FDA Registered',
  'Lab Tested Every Batch',
  '100% Made in USA',
];

// Third entry carries no image on purpose: the legacy page pairs it with the
// pipeline diagram below the row rather than with a photograph, and
// `.wwu-prop-row` is an auto-fit grid so a row with one child fills the width.
const VALUE_PROPS = [
  ['#1. Quality products you can trust',
   'Made in the USA. Automated manufacturing systems control critical steps throughout every run, while in-process checks and batch records keep every lot traceable.',
   encapsulationMachine,
   'An encapsulation machine turret at Ally Nutra, empty capsule bodies loaded in its segment rings'],
  ['#2. Fast responses from a team you can always reach',
   'You’ll work with a named contact who knows your product and order. We answer calls directly and respond to emails within hours, not days.',
   teamGroup,
   'The Ally Nutra team, eleven people, standing together in the Dover facility'],
  ['#3. Real-time visibility into production progress',
   'Follow your order through the client portal, from material readiness and scheduling to production and shipment. See what stage your run is in without asking.',
   null,
   null],
];

// The legacy pipeline diagram, redrawn [#3870]. It is inline HTML on that page,
// not a picture of one, so it is redrawn here rather than screenshotted — a
// screenshot of 12 stages is illegible on a phone and cannot be read aloud.
//
// Geometry is the legacy graph's, unchanged: a 1384x172 board, 104x44 stage
// boxes on a 128px pitch, three rows at y=0 / 64 / 128. COLOUR is not: every
// fill and stroke comes from this app's tokens, applied through `.wwu-node*` in
// `global.css` rather than as attributes here.
//
// ⚠️ Stage state is ILLUSTRATIVE — a representative order, not live data. The
// caption says so, and it is the caption that keeps this honest: nothing on this
// page reads a real job.
const PIPE_DONE = [
  { x: 0, y: 64, lines: ['Lead / Quote'] },
  { x: 128, y: 64, lines: ['PO Pending'] },
  { x: 256, y: 64, lines: ['Sample / Flav'] },
  { x: 384, y: 64, lines: ['Formula', 'Locked'] },
  { x: 512, y: 0, lines: ['Procurement'] },
  { x: 512, y: 128, lines: ['Designer', 'Workspace'] },
  { x: 640, y: 0, lines: ['Receiving'] },
  { x: 768, y: 64, lines: ['Raw QC'] },
  { x: 896, y: 64, lines: ['Production'] },
];
const PIPE_NOW = [{ x: 1024, y: 0, num: '9', lines: ['Final QC'] }];
const PIPE_NEXT = [
  { x: 1024, y: 128, num: '10', lines: ['Pkg /', 'Labeling'] },
  { x: 1152, y: 64, num: '11', lines: ['Shipping'] },
  { x: 1280, y: 64, num: '12', lines: ['Complete'] },
];

const PIPE_EDGES = [
  'M104,86 C115.5,86 115.5,86 127,86',
  'M232,86 C243.5,86 243.5,86 255,86',
  'M360,86 C371.5,86 371.5,86 383,86',
  'M488,86 C499.5,86 499.5,22 511,22',
  'M488,86 C499.5,86 499.5,150 511,150',
  'M616,22 C627.5,22 627.5,22 639,22',
  'M744,22 C755.5,22 755.5,86 767,86',
  'M616,150 C691.5,150 691.5,86 767,86',
  'M872,86 C883.5,86 883.5,86 895,86',
  'M1000,86 C1011.5,86 1011.5,22 1023,22',
  'M1000,86 C1011.5,86 1011.5,150 1023,150',
  'M1128,22 C1139.5,22 1139.5,86 1151,86',
  'M1128,150 C1139.5,150 1139.5,86 1151,86',
  'M1256,86 C1267.5,86 1267.5,86 1279,86',
];

const FORMATS = [
  ['Capsules', 'Fast absorption, easy to swallow. Masks taste and odor.', formatCapsules,
   'An Ally Nutra multivitamin capsule bottle with two capsules beside it'],
  ['Sachets', 'Portable single-serve portions for powders and granules.', formatSachets,
   'An Ally Nutra energy-booster sachet standing beside its retail carton'],
  ['Stick Packs', 'On-the-go convenience with controlled portions.', formatStickPacks,
   'Three Ally Nutra electrolyte stick packs standing beside their retail carton'],
  ['Pouches', 'Resealable, flexible sizing, extended freshness.', formatPouches,
   'An Ally Nutra resealable stand-up protein pouch'],
  ['Tubs', 'Bulk servings with a scoop, for powders sold by the month.', formatTubs,
   'An Ally Nutra collagen-peptides tub with a filled scoop beside it'],
];

const STATS = [
  ['100k+', 'Products manufactured'],
  ['4hr', 'Average response time'],
  ['5', 'Formats under one roof'],
  ['100%', 'Made in the USA'],
];

const CERTS = [
  [certNsf, 'NSF/ANSI 455-2 Certified'],
  [certFda, 'FDA Registered Food Facility'],
  [certCgmp, 'cGMP Compliant'],
  [certUsa, 'Made in the USA'],
];

// The three bullets beside the scheduler. The fourth line the legacy page shows
// here — "Pick a time that works. Speak to our specialist" — is its section
// sub-heading, not a bullet, and is rendered as one below.
const BOOK_POINTS = [
  'Tell us about your product and goals',
  'Scale your brand with confidence',
  'Find out whether we’re the right manufacturing partner',
];


/**
 * One 104x44 stage box on the pipeline board.
 *
 * `num` is the stage number shown inside the status dot; `null` means the stage
 * is complete and the dot carries a checkmark instead. The caller decides which
 * by putting the stage in the matching `<g>` — colour is the group's job, so
 * this renders the same shapes either way.
 */
function PipeStage({ x, y, num = null, lines }) {
  const cy = y + 22;
  return (
    <>
      <rect x={x} y={y} width="104" height="44" rx="8" />
      <circle cx={x + 17} cy={cy} r="8.5" />
      {num === null ? (
        <path className="wwu-node-tick" d={`M${x + 13.4},${cy} l2.6,2.6 l4.6,-5`} />
      ) : (
        <text className="wwu-node-num" x={x + 17} y={cy + 3.1} textAnchor="middle">{num}</text>
      )}
      {lines.length === 1 ? (
        <text x={x + 31} y={cy + 3.4}>{lines[0]}</text>
      ) : (
        lines.map((line, i) => (
          <text key={line} x={x + 31} y={cy - 2 + i * 11.5}>{line}</text>
        ))
      )}
    </>
  );
}

/**
 * One FAQ row.
 *
 * Same mechanism as `Faq.jsx`'s accordion, and deliberately the same classes:
 * opening measures `.accordion-panel`'s real `scrollHeight` (which its own
 * `max-height:0`/`overflow:hidden` does not affect) at the moment of the click
 * and animates to that pixel value; closing returns `max-height` to 0 and lets
 * the CSS transition collapse it.
 *
 * `open` is the PARENT's state rather than this row's, because the legacy page
 * shows one answer at a time. The measured height is local: it belongs to this
 * row's panel and nothing else needs it.
 */
function FaqItem({ index, question, answer, open, onToggle }) {
  const panelRef = useRef(null);
  const [openHeight, setOpenHeight] = useState(0);

  function toggle() {
    if (!open && panelRef.current) setOpenHeight(panelRef.current.scrollHeight + 20);
    onToggle();
  }

  return (
    <div className="accordion-item" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="accordion-trigger"
        aria-expanded={open ? 'true' : 'false'}
        onClick={toggle}
      >
        <span className="q-mark">{`Q.0${index + 1}`}</span>
        <span className="q-text">{question}</span>
        <span className="accordion-icon" aria-hidden="true"></span>
      </button>
      <div
        className="accordion-panel"
        ref={panelRef}
        style={{ maxHeight: open ? `${openHeight}px` : '0px' }}
      >
        <div className="accordion-panel-inner">
          <p>{answer}</p>
        </div>
      </div>
    </div>
  );
}

/** [FEAT-820 p2] How long the booked confirmation holds before /thank-you-booked. */
export const THANK_YOU_REDIRECT_MS = 2500;

/**
 * The `/work-with-us` ad page, and — through its props — the A/B test's page B
 * [FEAT-839]. Every default is the CONTROL's value; a prop left out renders the
 * control exactly as it rendered before page B existed.
 *
 * `schedulingUrl` replaces only the iClosed EVENT: the frame still renders only
 * where `consultationUrl()` is configured.
 *
 * [FEAT-859 / #5775] BOTH pages forward the visitor's UTM / click-id markers into the
 * frame (`iclosedPassthroughParams`), and `IClosedInlineEmbed` adds the saved first touch
 * and visitor id. Until 2026-10-06 the control forwarded none (requester ruling
 * 2026-10-02, page B only); the 2026-10-06 request reverses it, because without them a
 * control-page booking reaches iClosed with no source and the A/B test cannot be read.
 */
export default function WorkWithUs({
  headline = 'Is your manufacturer holding your brand back?',
  lede = 'Bring us your formula, make the product the way you want, and never run out of stock.',
  pricingNote = null,
  faqs = FAQS,
  schedulingUrl = null,
}) {
  const [openFaq, setOpenFaq] = useState(-1);
  const { search } = useLocation();

  // [FEAT-820] The hero video plays from Vidalytics. Its picture-in-picture window (the
  // player pins itself to a corner once the hero scrolls away) must never sit on the
  // booking calendar (owner, 2026-09-30: "we dont want it to be a problem when they are
  // actually booking"). Pausing alone does not close that window — measured on the live
  // embed — so while the booking section is on screen the player is paused AND the frame
  // carries `data-booking`, which hides the embed, floating window included. If
  // Vidalytics cannot load at all, the frame is left out rather than shown empty.
  //
  // The thank-you video further down is NOT held to the hero's no-skip rule: it plays
  // AFTER a booking is confirmed, so there is no pitch left to protect.
  const [vslPlayer, setVslPlayer] = useState(null);
  const [vslFailed, setVslFailed] = useState(false);
  const [bookingOnScreen, setBookingOnScreen] = useState(false);
  const bookSection = useRef(null);
  useEffect(() => {
    const node = bookSection.current;
    if (!node || typeof IntersectionObserver !== 'function') return undefined;
    const watch = new IntersectionObserver(([entry]) => setBookingOnScreen(entry.isIntersecting));
    watch.observe(node);
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    if (bookingOnScreen && vslPlayer && !vslPlayer.paused()) vslPlayer.pause('booking');
  }, [bookingOnScreen, vslPlayer]);

  // [FEAT-839] No Meta dataset is started here. FEAT-642 initialised the campaign's
  // dataset (2529780757518815) from this view; the HubSpot tracking code now loads
  // that same dataset on every page, so the call was removed — keeping both sent this
  // page two PageViews. `WorkWithUsPixelMount.test.js` fails if a pixel call returns.

  // Set once, when iClosed reports a confirmed booking [FEAT-640 / #4156]. The
  // decision of WHAT counts as that signal is not made here: `IClosedInlineEmbed`
  // already checks the exact origin and the exact message type, which matters
  // because iClosed sends ~60 `iclosed.widget_height` messages per visit and a
  // looser test would show this confirmation to someone who has booked nothing.
  const [booked, setBooked] = useState(false);
  const bookedRef = useRef(null);

  /**
   * ⚠️ THIS HANDLER HANDS THE BOOKING OVER; THE THANK-YOU PAGE COUNTS IT [BUG-840 / #6034].
   *
   * iClosed's `iclosed.call_scheduled` message DOES reach this page in production: it is
   * the only trigger of the in-app move to /thank-you-booked below, which the owner's
   * 2026-10-07 test booking showed. BUG-837 had stopped this handler reporting anything,
   * on the belief that the message never arrives and iClosed's redirect to
   * /thank-you-booked?previewId=… would bring the booking instead; that redirect never
   * lands, so from BUG-837 until this fix no booking was counted at all.
   *
   * It pushes nothing itself. It leaves a single-use token in memory, and the thank-you
   * page's `reportBookedCall()` pushes ONE `call_scheduled` for it after the move, which is
   * the same place iClosed's redirect would be counted if it ever did land
   * (`lib/bookedCall.js`). `views/__tests__/WorkWithUsBooked.test.js` pins both halves.
   */
  function handleBooked() {
    handOverBookedCall();
    setBooked(true);
  }

  // The scroll lives in an effect, not in the handler above, and the reason is
  // ordering rather than style: at the moment the handler runs the confirmation
  // has not rendered, so `bookedRef.current` is still null and a scroll written
  // there would silently do nothing. This runs after the commit that puts it in
  // the document.
  //
  // It is worth doing at all because the visitor's eyes are inside the iframe,
  // partway down a 490px frame, when the section's body is swapped underneath
  // them. `/schedule/` scrolls for the same reason.
  useEffect(() => {
    if (!booked) return;
    const node = bookedRef.current;
    // jsdom implements no scrolling, so this is ABSENT there rather than inert —
    // a bare call would throw and take the confirmation down with it.
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [booked]);

  // [FEAT-820 p2 / #5606] Then the visitor moves on to /thank-you-booked, as on the old
  // site (owner, 2026-09-30), after a short confirmation. [BUG-840] The pause does NOT
  // keep iClosed's frame alive: the confirmation replaces the booking form, frame
  // included, the moment the booking message arrives. Anything iClosed does in its frame
  // after posting that message is cut short, and its redirect to
  // /thank-you-booked?previewId=… has never been seen on this site.
  const navigate = useNavigate();
  useEffect(() => {
    if (!booked) return undefined;
    const timer = setTimeout(() => navigate('/thank-you-booked'), THANK_YOU_REDIRECT_MS);
    return () => clearTimeout(timer);
  }, [booked, navigate]);

  return (
    <section className="wwu" aria-labelledby="wwu-h1" data-testid="work-with-us">
      {/* 1 — Hero + VSL */}
      <section id="hero" className="hero on-navy" data-testid="wwu-hero">
        <div className="container wwu-hero-inner">
          <h1 id="wwu-h1">{headline}</h1>
          <p className="lede wwu-hero-lede">{lede}</p>
          {/* Wider than the text column above it on purpose — this is the hero of
              the page, and a 16:9 video confined to a reading measure reads as an
              afterthought. The frame holds the 16:9 box the poster already fills, so
              the hero does not jump when the first frame arrives. The SOURCES are the
              two tiers this app bundles, from the same files Home.jsx plays — this
              frame is what `src/lib/workWithUsMedia.js` is for. Muted autoplay with
              controls, so tapping gives sound — the legacy behaviour, and the one
              thing this player does NOT share with Home's click-to-play VSL. */}
          {vslFailed ? null : (
            <div className="wwu-vsl-frame" data-booking={bookingOnScreen ? '' : undefined}>
              <VidalyticsVideo
                embed={WORK_WITH_US_VSL}
                onPlayer={setVslPlayer}
                onFailed={setVslFailed}
                testId="wwu-vidalytics"
              />
            </div>
          )}
          <a
            className="btn btn-primary btn-lg"
            href="#book"
            onClick={trackCtaClick}
            data-testid="wwu-cta-hero"
          >
            Work With Us →
          </a>
          <div className="hero-chip-row wwu-hero-chips">
            {HERO_CHIPS.map((label) => (
              <span key={label} className="hero-chip">
                <CheckIcon width={14} height={14} />
                {label}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* 2 — Stat band */}
      <section id="stats" className="section-tight wwu-stat-band" data-testid="wwu-stats">
        <div className="container simple-stats wwu-stats-grid">
          {STATS.map(([value, label]) => (
            <div key={label} className="simple-stat">
              <div className="num">{value}</div>
              <div className="lbl">{label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 3 — What you get */}
      <section id="what-you-get" className="section" data-testid="wwu-what-you-get">
        <div className="container">
          <div className="section-header">
            <h2>What you get when you work with us</h2>
          </div>
          <div className="wwu-prop-rows">
            {VALUE_PROPS.map(([heading, body, image, imageAlt]) => (
              <article key={heading} className="wwu-prop-row">
                <div className="wwu-prop-copy">
                  <h3>{heading}</h3>
                  <p>{body}</p>
                </div>
                {image ? (
                  <figure className="photo ratio-4x3 wwu-prop-photo">
                    <img src={image} alt={imageAlt} loading="lazy" />
                  </figure>
                ) : null}
              </article>
            ))}
          </div>

          <figure className="wwu-pipe-card">
            <figcaption className="wwu-pipe-head">
              <span className="wwu-pipe-label">Pipeline</span>
              <span className="wwu-pipe-progress">Example order · stage 9 of 12</span>
            </figcaption>
            {/* Horizontally scrollable rather than reflowed: the graph's meaning
                IS its left-to-right order, and stacking 12 boxes into a column
                destroys it. `min-width` on the svg keeps the labels legible; the
                container scrolls inside the card, so the PAGE never does. */}
            <div className="wwu-pipe-scroll">
              <svg
                className="wwu-pipe"
                viewBox="0 0 1384 172"
                role="img"
                aria-label="Production pipeline: stages one through eight complete, Final QC in progress, packaging, shipping and completion still ahead."
              >
                <defs>
                  <marker
                    id="wwu-pipe-arrow"
                    markerWidth="7"
                    markerHeight="7"
                    refX="5.5"
                    refY="3"
                    orient="auto"
                    markerUnits="strokeWidth"
                  >
                    <path className="wwu-pipe-arrowhead" d="M0,0 L6,3 L0,6 Z" />
                  </marker>
                </defs>
                <g className="wwu-pipe-edges">
                  {PIPE_EDGES.map((d) => (
                    <path key={d} d={d} markerEnd="url(#wwu-pipe-arrow)" />
                  ))}
                </g>
                <g className="wwu-node wwu-node-done">
                  {PIPE_DONE.map((stage) => (
                    <PipeStage key={`${stage.x}-${stage.y}`} {...stage} />
                  ))}
                </g>
                <g className="wwu-node wwu-node-now">
                  {PIPE_NOW.map((stage) => (
                    <PipeStage key={`${stage.x}-${stage.y}`} {...stage} />
                  ))}
                </g>
                <g className="wwu-node wwu-node-next">
                  {PIPE_NEXT.map((stage) => (
                    <PipeStage key={`${stage.x}-${stage.y}`} {...stage} />
                  ))}
                </g>
              </svg>
            </div>
          </figure>
        </div>
      </section>

      {/* 4 — Five formats */}
      <section id="formats" className="section section-alt" data-testid="wwu-formats">
        <div className="container">
          <div className="section-header">
            <h2>Five formats.</h2>
            <p>Switching formats never means switching partners.</p>
          </div>
          {/* No `Format-0N` label on these cards, unlike the ones on /services.
              apps/landing/CLAUDE.md forbids hand-writing that numbering anywhere
              in this app — it is derived from `src/data/offeredFormats.js`, which
              presents FOUR formats since [FEAT-310] deactivated Tablets. This ad
              page carries the legacy five, so a number written here would
              contradict the rest of the site. See the PR for #3870. */}
          <div className="grid wwu-formats-grid">
            {FORMATS.map(([name, blurb, image, imageAlt]) => (
              <article key={name} className="format-card">
                {/* Not `.photo`: that class applies a navy soft-light duotone
                    meant for facility photography, and these are white-background
                    brand renders — tinting them navy is exactly the treatment
                    they must not get. `object-fit:contain` for the same reason
                    `cover` is wrong here, it would crop the packaging. */}
                <div className="wwu-format-media">
                  <img src={image} alt={imageAlt} loading="lazy" />
                </div>
                <div className="format-body">
                  <h3>{name}</h3>
                  <p>{blurb}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* 5 — Booking. `IClosedInlineEmbed` per #3556: never iClosed's
          widget.js, matching /schedule/ and Contact. */}
      <section id="book" className="section section-navy" data-testid="wwu-book" ref={bookSection}>
        <div className="container">
          <div className="section-header">
            {/* `.eyebrow` is inline-flex and `.section-header` is text-align:center,
                so it centres without a style override. */}
            <span className="eyebrow on-dark">Work with us</span>
            <h2>{booked ? 'Your call is booked' : 'A reliable supply chain starts here'}</h2>
            <p>
              {booked
                ? 'A calendar invite is on its way to your inbox with the meeting link and everything you need.'
                : 'Pick a time that works. Speak to our specialist'}
            </p>
          </div>
          {booked ? (
            /* The confirmation, in place of the booking form [FEAT-640 / #4156] —
               since [FEAT-820 p2] a short bridge: the thank-you video and the three
               next steps are on /thank-you-booked, which the effect above opens after
               `THANK_YOU_REDIRECT_MS`. The form is gone, not covered: a live scheduler
               under a confirmation invites a second booking for the same visitor. */
            <div className="wwu-booked" data-testid="wwu-booked" ref={bookedRef}>
              <p className="wwu-booked-note">
                Not there in a few minutes? Check spam or promotions.
              </p>
              <p className="wwu-booked-note" data-testid="wwu-booked-next">
                Taking you to your next steps…
              </p>
            </div>
          ) : (
            <>
              <ul className="wwu-book-points">
                {BOOK_POINTS.map((point) => (
                  <li key={point}>
                    <CheckIcon width={18} height={18} />
                    {point}
                  </li>
                ))}
              </ul>
              {/* [FEAT-839] Page B's pricing line, directly above the booking form.
                  The control passes none and renders nothing here. */}
              {pricingNote ? (
                <p className="wwu-book-pricing" data-testid="wwu-book-pricing">
                  {pricingNote}
                </p>
              ) : null}
              {/* Guarded exactly the way Contact.jsx guards the same component, and
                  for a reason measured on this page: `consultationUrl()` returns
                  NULL when `VITE_ICLOSED_CONSULTATION_URL` is unset, and
                  `buildIClosedBookingUrl` then throws `Failed to construct 'URL':
                  Invalid URL`. There is no error boundary above this view, so the
                  throw takes the WHOLE page down — an unconfigured deployment
                  serves a blank document, not a page missing its scheduler. Renders
                  identically wherever the URL is configured, which is every real
                  deployment. */}
              {consultationUrl() ? (
                <div className="wwu-book-embed iclosed-embed-shell">
                  <IClosedInlineEmbed
                    schedulingUrl={schedulingUrl ?? consultationUrl()}
                    utm={iclosedPassthroughParams(search)}
                    onBooked={handleBooked}
                  />
                </div>
              ) : null}
            </>
          )}
        </div>
      </section>

      {/* 6 — Facility */}
      <section id="facility" className="section" data-testid="wwu-facility">
        <div className="container">
          <div className="section-header">
            <h2>ISO Class 7 Production Cleanroom.</h2>
            <p>
              Our production facility incorporates design and engineering controls commonly used in
              pharmaceutical manufacturing.
            </p>
          </div>
          <figure className="photo ratio-16x9 wwu-facility-photo">
            <img src={facilityCorridor} alt="Ally Nutra production corridor" loading="lazy" />
          </figure>
        </div>
      </section>

      {/* 7 — Certifications */}
      <section id="certifications" className="section section-alt" data-testid="wwu-certifications">
        <div className="container">
          <div className="section-header">
            <h2>Certifications</h2>
          </div>
          {/* `alt=""` because the `<figcaption>` beside it carries the same
              words: with both, a screen reader reads every badge twice. The mark
              is the decoration, the caption is the claim. */}
          <div className="grid wwu-cert-badges">
            {CERTS.map(([src, label]) => (
              <figure key={label} className="wwu-cert-badge">
                <img src={src} alt="" loading="lazy" />
                <figcaption>{label}</figcaption>
              </figure>
            ))}
          </div>
          {/* The two cards below carry SCANS of real documents, which is why they
              are separated from the four marks above: a mark is a claim, a scan
              is the evidence for one. The numbers beside each are read off the
              document in the image and must keep matching it. */}
          <div className="grid grid-2 wwu-cert-docs">
            <article className="cert-card wwu-cert-doc">
              <img
                className="wwu-cert-scan"
                src={nsfCertificate}
                alt="NSF International Certificate of Conformity for Ally Nutra, LLC — certification number C0871161-HSCDS-1"
                loading="lazy"
              />
              <div>
                <h3>NSF/ANSI 455-2 Certified</h3>
                <div className="cert-meta">
                  <span><strong>C0871161-HSCDS-1</strong>Certificate number</span>
                  <span><strong>13 January 2027</strong>Valid through</span>
                </div>
              </div>
            </article>
            <article className="cert-card wwu-cert-doc">
              <img
                className="wwu-cert-scan"
                src={fdaRegistration}
                alt="FDA food facility registration for Ally Nutra — unique facility identifier 119292347, status VALID"
                loading="lazy"
              />
              <div>
                <h3>FDA Registered Food Facility</h3>
                <div className="cert-meta">
                  <span><strong>119292347</strong>Unique facility identifier</span>
                  <span><strong>31 December 2026</strong>Registration valid through</span>
                </div>
              </div>
            </article>
          </div>
        </div>
      </section>

      {/* 8 — FAQ */}
      <section id="faq" className="section" data-testid="wwu-faq">
        <div className="container">
          <div className="section-header">
            <h2>Questions we get often</h2>
          </div>
          <div className="wwu-faq-list">
            {faqs.map(([question, answer], i) => (
              <FaqItem
                key={question}
                index={i}
                question={question}
                answer={answer}
                open={openFaq === i}
                onToggle={() => setOpenFaq(openFaq === i ? -1 : i)}
              />
            ))}
          </div>
          <div className="wwu-cta-row">
            <a
              className="btn btn-primary btn-lg"
              href="#book"
              onClick={trackCtaClick}
              data-testid="wwu-cta-faq"
            >
              Work With Us →
            </a>
          </div>
        </div>
      </section>

      {/* Minimal footer [FEAT-589 / #3902] — the legacy page's three items and
          nothing else: logo, two policy links, copyright. Not a ninth content
          section (no `<section data-testid="wwu-…">`), and not the site Footer,
          which `Layout` withholds from this page. Both links open in a new tab
          so the visitor's place in the booking flow is kept. */}
      <footer className="wwu-footer" data-testid="wwu-footer">
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
