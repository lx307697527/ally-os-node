import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { sx } from '../lib/styleString.js';
// [FEAT-310] Owner decision (Zed, 2026-09-02): tablets deactivated. The stat
// below and its caption are derived from this module so the number and the
// list can never disagree (they already had: the stat said 5 while the quote
// form offered 4).
import {
  OFFERED_FORMAT_COUNT,
  offeredFormatMiddotLines,
} from '../data/offeredFormats.js';

/** The CH-02 stat caption, split across its two lines. Static — computed once. */
const FORMAT_CAPTION_LINES = offeredFormatMiddotLines();
import { hideAndTint } from '../lib/imgFallback.js';
import { scrollToId } from '../lib/scrollToId.js';

import qcGlassware from '../assets/images/qc-volumetric-glassware.jpg';
import rawMaterialIntake from '../assets/images/raw-material-intake.jpg';
import capsuleMachine from '../assets/images/njp-2500-capsule-machine.jpg';
import stickPackFillingLine from '../assets/images/source-stick-pack-filling-line.webp';
import rawMaterialWarehouse from '../assets/images/raw-material-warehouse.jpg';

// Relocated from the home view (2026 conversion restructure) — the process
// narrative a visitor wants once they're already interested in the company, not
// before. See docs/PLAN.md for why this moved off Home.
const ABOUT_STAGES = [
  {
    stage: 1,
    img: qcGlassware,
    alt: "Volumetric glassware in Ally Nutra's on-site QC laboratory",
    title: 'Formulation support',
    body: 'Collaborate with your dedicated representative to design a formula that aligns with your vision. Our R&D team then refines the product prototype before production.',
  },
  {
    stage: 2,
    img: rawMaterialIntake,
    alt: 'Incoming ingredients and packaging staged on the Ally Nutra receiving floor',
    title: 'Ingredient sourcing',
    body: 'We source the ingredients and components required for your approved formula and prepare them for manufacturing.',
  },
  {
    stage: 3,
    img: capsuleMachine,
    alt: 'An NJP-2500 automatic capsule filling machine on the production floor',
    title: 'Certified manufacturing',
    // [FEAT-310] "and compression" REMOVED. Compression is the tablet-pressing
    // process, and this page was the only place claiming it runs on-site while
    // Facility.jsx's Equipment section deliberately excludes tablet presses —
    // a contradiction apps/landing/CLAUDE.md logged as an unresolved
    // business-facts question. The owner's decision settles the OFFERING
    // (tablets are not sold) but not the EQUIPMENT (whether a press exists in
    // Dover is still unconfirmed anywhere in either repo), so the claim is
    // dropped rather than rewritten into a fact nobody has. FLAGGED FOR OWNER
    // CONFIRMATION in the PR body — if a press does exist, this is a sentence
    // to restore, not to re-derive.
    body: 'Blending and encapsulation take place at our FDA-registered, NSF/ANSI 455-2 certified facility in Dover, Delaware.',
  },
  {
    stage: 4,
    img: stickPackFillingLine,
    alt: 'Stick-pack filling and sealing equipment from the approved AllyNutra source site',
    title: 'Packaging and labeling',
    body: 'We manufacture capsules, sachets, stick packs, and resealable pouches, then bottle, pack, and label the finished product for your brand.',
  },
  {
    stage: 5,
    img: rawMaterialWarehouse,
    alt: "Blue and orange pallet racking inside Ally Nutra's raw material warehouse",
    title: 'Fulfillment',
    body: 'Finished products can ship to your door, your warehouse or 3PL, or directly to an Amazon fulfillment center after FBA preparation.',
  },
];

// Sticky-scroll narrative. Ported from Home.jsx's original IntersectionObserver-driven
// implementation — always acts on the entry with the largest intersectionRatio, never
// more than one stage per callback, so two captions never both read as active during a
// fast scroll. Disconnected below 901px, where CSS switches to a plain inline stack.
function AboutScroll() {
  const stageRefs = useRef({});
  const [activeStage, setActiveStage] = useState(1);
  const activeStageRef = useRef(1);

  useEffect(() => {
    activeStageRef.current = activeStage;
  }, [activeStage]);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    let observer = null;

    function connect() {
      if (observer) return;
      observer = new IntersectionObserver(
        (entries) => {
          let best = null;
          entries.forEach((entry) => {
            if (entry.isIntersecting && (!best || entry.intersectionRatio > best.intersectionRatio)) {
              best = entry;
            }
          });
          if (best) {
            const stage = Number(best.target.dataset.stage);
            if (stage !== activeStageRef.current) {
              activeStageRef.current = stage;
              setActiveStage(stage);
            }
          }
        },
        { rootMargin: '-35% 0px -45% 0px', threshold: 0 }
      );
      Object.values(stageRefs.current).forEach((el) => el && observer.observe(el));
    }
    function disconnect() {
      if (!observer) return;
      observer.disconnect();
      observer = null;
    }

    // [FEAT-088] The complement of `.about-sticky-col{display:none}` in
    // global.css, and it has to stay the complement: this observer is what makes
    // that column do anything, so a one-pixel disagreement renders the column at
    // that width and never activates it. The old pairing was max-width:900 /
    // min-width:901; design.md section 5.2 spells the same boundary
    // max-width:899 / min-width:900, so this literal moved with the sheet.
    const mq = window.matchMedia('(min-width: 900px)');
    function syncToBreakpoint() {
      if (mq.matches) connect();
      else disconnect();
    }
    syncToBreakpoint();
    if (mq.addEventListener) mq.addEventListener('change', syncToBreakpoint);
    else if (mq.addListener) mq.addListener(syncToBreakpoint);

    return () => {
      disconnect();
      if (mq.removeEventListener) mq.removeEventListener('change', syncToBreakpoint);
      else if (mq.removeListener) mq.removeListener(syncToBreakpoint);
    };
  }, []);

  function goTo(stage) {
    stageRefs.current[stage]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  return (
    <section className="section about-scroll">
      <div className="container about-scroll-grid">
        <div className="about-sticky-col">
          <div className="about-frame">
            {ABOUT_STAGES.map((s) => (
              <img
                key={s.stage}
                className={`about-img${activeStage === s.stage ? ' on' : ''}`}
                data-stage={s.stage}
                src={s.img}
                width="900"
                height="675"
                alt={s.alt}
                loading={s.stage === 1 ? 'eager' : 'lazy'}
                onError={hideAndTint}
              />
            ))}
            <div className="about-img-tint" aria-hidden="true"></div>
          </div>
          <div className="about-rail" role="group" aria-label="Jump to a stage">
            {ABOUT_STAGES.map((s) => (
              <button
                key={s.stage}
                type="button"
                className={`about-rail-num${activeStage === s.stage ? ' on' : ''}`}
                data-goto={s.stage}
                aria-label={`Go to stage ${s.stage}: ${s.title}`}
                onClick={() => goTo(s.stage)}
              >
                {String(s.stage).padStart(2, '0')}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="about-intro">
            <span className="eyebrow">How we work</span>
            <h2 style={sx('margin:14px 0 18px;')}>
              From formula to finished product — <em style={sx('font-style:italic;color:hsl(var(--ally-navy))')}>five stages</em>.
            </h2>
            <p>
              Every order moves through the same documented process, whether it's your
              first SKU or your fiftieth.
            </p>
          </div>

          {ABOUT_STAGES.map((s) => (
            <div
              key={s.stage}
              ref={(el) => {
                stageRefs.current[s.stage] = el;
              }}
              className={`about-stage${activeStage === s.stage ? ' on' : ''}`}
              data-stage={s.stage}
            >
              <div className="about-stage-mobile-img">
                <img
                  src={s.img}
                  width="900"
                  height="675"
                  alt={s.alt}
                  loading={s.stage === 1 ? 'eager' : 'lazy'}
                  onError={hideAndTint}
                />
              </div>
              <span className="about-stage-num">{String(s.stage).padStart(2, '0')}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// Relocated from the home view's "Company snapshot" — scroll-triggered count-up,
// played once via IntersectionObserver (never a scroll listener) + requestAnimationFrame
// (never setInterval). Certifications and format counts corrected to match the
// dedicated Certifications and Home pages exactly (see docs/PLAN.md).
function AnimatedStat({ count, suffix, mode, delay }) {
  const [display, setDisplay] = useState('0');
  const rafRef = useRef(null);

  useEffect(() => {
    if (mode === 'final') {
      setDisplay(count.toLocaleString() + suffix);
      return;
    }
    if (mode !== 'animate') return;

    let start = null;
    let cancelled = false;
    const duration = 1400;
    function easeOutCubic(p) {
      return 1 - Math.pow(1 - p, 3);
    }
    const timer = setTimeout(() => {
      function step(ts) {
        if (cancelled) return;
        if (start === null) start = ts;
        const p = Math.min(1, (ts - start) / duration);
        const eased = easeOutCubic(p);
        const current = Math.round(eased * count);
        // Suffix only on the true final frame — a counting "347+" is a lie.
        setDisplay(current.toLocaleString() + (p >= 1 ? suffix : ''));
        if (p < 1) rafRef.current = requestAnimationFrame(step);
      }
      rafRef.current = requestAnimationFrame(step);
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [mode, count, suffix, delay]);

  return (
    <span className="stat-live" aria-hidden="true" data-count={count} data-suffix={suffix}>
      {display}
    </span>
  );
}

function StatPanel() {
  const panelRef = useRef(null);
  const [mode, setMode] = useState('idle');
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      setMode('final');
      setRevealed(true);
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setMode('final');
      setRevealed(true);
      return;
    }

    const initialRect = panel.getBoundingClientRect();
    if (initialRect.bottom < 0) {
      setMode('final');
      setRevealed(true);
      return;
    }

    let played = false;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (played) return;
          if (entry.isIntersecting) {
            played = true;
            setRevealed(true);
            setMode('animate');
            io.unobserve(panel);
          } else if (entry.boundingClientRect.bottom < 0) {
            played = true;
            setMode('final');
            setRevealed(true);
            io.unobserve(panel);
          }
        });
      },
      { threshold: [0, 0.5] }
    );
    io.observe(panel);
    return () => io.disconnect();
  }, []);

  return (
    <div className={`stat-panel${revealed ? ' in' : ''}`} ref={panelRef}>
      <div className="stat-panel-head">
        <span>System · Ally Nutra QMS</span>
        <span>Dover, Delaware</span>
      </div>
      {/* CLAIMS REMEDIATION — was grid-4, 8 cells. Removed outright, no
          source anywhere in either repo: "Brands served" (500+), "Units
          shipped" (10M+), "Facility size" (50,000 sq ft — see the note on
          Facility.jsx's simple-stats for why no replacement number is
          stated either), "In-house formulators" (15+ — PhDs/nutritionists/
          chemists), and "Raw materials on file" (2,000+ — the one
          enumerable ingredient list found in ally-nutra has 402 rows).
          "Certifications" (was 6: cGMP/FDA/NSF/organic/halal/kosher)
          corrected to 3 now that organic/halal/kosher are gone from the
          Certifications page. Renumbered CH-01..03 sequentially rather
          than leaving gaps; grid-3 (not grid-4) so 3 real stats form one
          full row instead of a mostly-empty one — .grid-3 already collapses
          to 2 cols at 1000px and 1 col at 640px via the existing generic
          rules, no new breakpoint needed. */}
      <div className="grid grid-2" style={sx('gap:0;')}>
        <div className="stat-cell" style={sx('border-bottom:none;')}>
          <span className="mono-chip">CH-01</span>
          <div className="stat-label">Formats manufactured</div>
          <div className="stat-value" aria-label={String(OFFERED_FORMAT_COUNT)}>
            <span className="stat-ghost" aria-hidden="true">{OFFERED_FORMAT_COUNT}</span>
            {/* Format-vocabulary alignment, 2026-08-26: 4 -> 5, Tablets added,
                Pouches -> Resealable Bags, per Dasi's approved Q1 list (see
                Home.jsx's PRODUCTS array comment).
                [FEAT-310] Back to 4, and no longer written as a literal: the count,
                the aria-label, the ghost digit and the caption all come from
                OFFERED_FORMATS. A hand-maintained "5" here is exactly how this cell
                came to contradict the quote form's own four options. */}
            <AnimatedStat count={OFFERED_FORMAT_COUNT} suffix="" mode={mode} delay={60} />
          </div>
          <div className="stat-sub">{FORMAT_CAPTION_LINES[0]}<br />{FORMAT_CAPTION_LINES[1]}</div>
        </div>
        <div className="stat-cell" style={sx('border-right:none;border-bottom:none;')}>
          <span className="mono-chip">CH-02</span>
          <div className="stat-label">Facility</div>
          <div className="stat-value" aria-label="Dover, Delaware">DE</div>
          <div className="stat-sub">FDA registered<br />NSF/ANSI 455-2 certified</div>
        </div>
      </div>
    </div>
  );
}

export default function About() {
  return (
    <section aria-labelledby="about-h1">
      <section className="hero on-navy">
        <div className="container hero-grid">
          <div>
            <span className="eyebrow on-dark">About Ally Nutra</span>
            <h1 id="about-h1" style={sx('color:#fff;margin-top:14px;')}>Full-service supplement manufacturing in Dover.</h1>
            <p style={sx("color:hsl(0 0% 100% / .78);margin:18px 0 0;max-width:480px;")}>
              We manufacture capsules, sachets, stick packs, and resealable pouches — with
              production, bottling, packaging, and logistics under one roof.
            </p>
            <div className="hero-ctas">
              <Link to="/contact" className="btn btn-primary btn-lg">Work with us →</Link>
              <a href="#our-story" className="btn btn-outline-light btn-lg" onClick={scrollToId('our-story')}>
                Read our story
              </a>
            </div>
          </div>
          <div style={sx("background:hsl(0 0% 100% / .04);border:1px solid hsl(var(--ally-orange)/.3);border-radius:var(--radius-lg);padding:36px 32px;position:relative;")}>
            <div style={sx("font-family:var(--font-slab);font-size:64px;color:hsl(var(--ally-orange));line-height:1;opacity:.5;")}>455-2</div>
            <p style={sx("font-family:var(--font-slab);font-size:19px;font-weight:500;color:#fff;line-height:1.4;margin:8px 0 24px;")}>
              NSF/ANSI 455-2 certified for dietary supplement Good Manufacturing Practices.
            </p>
            <div style={sx("display:flex;align-items:center;gap:14px;padding-top:18px;border-top:1px solid hsl(0 0% 100% / .15);")}>
              <div className="author-avatar" style={sx('width:42px;height:42px;')}>DE</div>
              <div>
                <strong style={sx('display:block;color:#fff;font-size:14px;')}>Dover, Delaware</strong>
                <span style={sx("color:hsl(var(--ally-orange));font-size:11.5px;text-transform:uppercase;letter-spacing:0.08em;")}>FDA-registered facility</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* AN-DESIGN-001 sweep, Group B item 8 — Mission & vision moved here,
          immediately after the hero, per the owner's directive. Everything
          below keeps its original relative order; only this section moved.
          Class changed section-alt → section (was section-alt where it used
          to sit, between two other light sections): unchanged, it would now
          sit directly before Company snapshot, which is also section-alt —
          two grey sections back to back with no visible boundary between
          them. This one-line class change is the minimal fix for that,
          not a second reorder. */}
      <section className="section">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>What drives us</span>
            <h2>Our mission and approach.</h2>
            <p>One manufacturing partner from product idea through finished supplement.</p>
          </div>
          <div className="grid grid-2">
            <div className="card" style={sx("border-left:4px solid hsl(var(--ally-orange));padding:36px;")}>
              <div className="mono-chip" style={sx("color:hsl(var(--muted-foreground));margin-bottom:12px;")}>Our mission</div>
              <h3 style={sx("font-size:22px;margin-bottom:14px;")}>We turn your ideas into real products.</h3>
              <p>You share your vision; we take raw ingredients and transform them into finished supplements — bottled, packed, labeled, and shipped to your door.</p>
            </div>
            <div className="card" style={sx("border-left:4px solid hsl(var(--ally-orange));padding:36px;")}>
              <div className="mono-chip" style={sx("color:hsl(var(--muted-foreground));margin-bottom:12px;")}>Our approach</div>
              <h3 style={sx("font-size:22px;margin-bottom:14px;")}>A true manufacturer — not a broker.</h3>
              <p>Production, bottling, packaging, and logistics are consolidated at our Dover facility across four delivery formats.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>Company snapshot</span>
            <h2>Four formats. One Dover facility.</h2>
          </div>
          <StatPanel />
        </div>
      </section>

      <section className="section" id="our-story">
        <div className="container hero-grid">
          <div>
            <span className="eyebrow">Who we are</span>
            <h2 style={sx('margin:14px 0 16px;')}>A full-service supplement manufacturer.</h2>
            <p style={sx('margin-bottom:16px;')}>
              Ally Nutra manufactures capsules, sachets, stick packs, and resealable pouches at
              its Dover, Delaware facility.
            </p>
            <p style={sx('margin-bottom:16px;')}>
              Our team supports product development, sourcing, manufacturing, bottling,
              packaging, quality checks, and logistics under one roof.
            </p>
            <p>
              {/* CLAIMS REMEDIATION — "over 500 brands" removed, no source
                  anywhere in either repo (same figure removed from the stat
                  panel above and the timeline below). */}
              <strong style={sx('color:hsl(var(--ally-navy));')}>
                Our facility is FDA registered and NSF/ANSI 455-2 certified
              </strong>{' '}
              — every time.
            </p>
          </div>
          <div>
            <div className="card" style={sx('padding:32px;')}>
              <div className="mono-chip" style={sx("color:hsl(var(--muted-foreground));margin-bottom:10px;")}>Headquartered in</div>
              <h3 style={sx("font-size:28px;margin-bottom:16px;")}>Dover, Delaware</h3>
              <p>
                Our U.S. facility supports formulation, manufacturing, packaging, and fulfillment.
              </p>
              {/* CLAIMS REMEDIATION — this card's mini-stat row (50K sq ft,
                  12+ production lines) is gone, same two unsourced figures
                  removed everywhere else on this page. No replacement
                  numbers stated; see the note on Facility.jsx's simple-stats
                  for why. */}
            </div>
          </div>
        </div>
      </section>

      <AboutScroll />

      <section className="section">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>Why partner with us</span>
            <h2>Support from idea through shipment.</h2>
            <p>Manufacturing, product development, packaging, and logistics are coordinated by one team.</p>
          </div>
          <div className="grid grid-3">
            <div className="card"><div style={sx("font-family:var(--font-slab);font-size:38px;color:hsl(var(--ally-orange-ink));margin-bottom:10px;")}>01</div><h3 style={sx("font-size:17px;margin-bottom:8px;")}>All-in-one solution</h3><p style={sx("font-size:13.5px;")}>Production, bottling, packaging, and logistics are consolidated under one roof.</p></div>
            <div className="card"><div style={sx("font-family:var(--font-slab);font-size:38px;color:hsl(var(--ally-orange-ink));margin-bottom:10px;")}>02</div><h3 style={sx("font-size:17px;margin-bottom:8px;")}>Custom formulation</h3><p style={sx("font-size:13.5px;")}>Work with our team to develop or refine the formula for your product.</p></div>
            <div className="card"><div style={sx("font-family:var(--font-slab);font-size:38px;color:hsl(var(--ally-orange-ink));margin-bottom:10px;")}>03</div><h3 style={sx("font-size:17px;margin-bottom:8px;")}>Four formats</h3><p style={sx("font-size:13.5px;")}>Capsules, sachets, stick packs, and resealable pouches are manufactured in house.</p></div>
            <div className="card"><div style={sx("font-family:var(--font-slab);font-size:38px;color:hsl(var(--ally-orange-ink));margin-bottom:10px;")}>04</div><h3 style={sx("font-size:17px;margin-bottom:8px;")}>Certified facility</h3><p style={sx("font-size:13.5px;")}>Our Dover facility is FDA registered and NSF/ANSI 455-2 certified.</p></div>
            <div className="card"><div style={sx("font-family:var(--font-slab);font-size:38px;color:hsl(var(--ally-orange-ink));margin-bottom:10px;")}>05</div><h3 style={sx("font-size:17px;margin-bottom:8px;")}>Testing support</h3><p style={sx("font-size:13.5px;")}>In-house and third-party testing support product quality review.</p></div>
            <div className="card"><div style={sx("font-family:var(--font-slab);font-size:38px;color:hsl(var(--ally-orange-ink));margin-bottom:10px;")}>06</div><h3 style={sx("font-size:17px;margin-bottom:8px;")}>Made in USA</h3><p style={sx("font-size:13.5px;")}>Products are manufactured at our facility in Dover, Delaware.</p></div>
          </div>
        </div>
      </section>

      <section className="section section-rule">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>Production capabilities</span>
            <h2>One partner across the product journey.</h2>
            <p>Our team coordinates the key stages required to turn a product idea into finished inventory.</p>
          </div>
          <div className="timeline">
            <div className="timeline-item"><div className="timeline-dot"></div><div className="timeline-year">Stage 1</div><h3>Formula and quote</h3><p style={sx("font-size:13.5px;")}>Share your vision and product requirements with our team.</p></div>
            <div className="timeline-item"><div className="timeline-dot"></div><div className="timeline-year">Stage 2</div><h3>Product development</h3><p style={sx("font-size:13.5px;")}>Refine the formula, format, and packaging before production.</p></div>
            {/* CLAIMS REMEDIATION — "Facility expansion to 50,000 sq ft" had
                the same unsourced figure removed elsewhere on this page;
                titled by what happened instead of by a number we can't
                verify. "200+ SKU" corrected to "500+" — ally-nutra's real
                RequestQuote.tsx bullets state "Access to 500+ pre-validated
                formulas," a bigger catalog than this page previously
                claimed. The "Today / 500+ brands and counting" milestone
                that used to close this timeline is gone — both of its
                figures (500+ brands, 10 million units) had no source
                anywhere in either repo, and there was no unflagged content
                left to end on once they were removed; the timeline now ends
                at Year 4 rather than closing on invented scale. */}
            <div className="timeline-item"><div className="timeline-dot"></div><div className="timeline-year">Stage 3</div><h3>Manufacturing and quality</h3><p style={sx("font-size:13.5px;")}>Manufacture and review the product at our certified Dover facility.</p></div>
            <div className="timeline-item"><div className="timeline-dot"></div><div className="timeline-year">Stage 4</div><h3>Packaging and shipping</h3><p style={sx("font-size:13.5px;")}>Package, label, and ship finished inventory to your chosen destination.</p></div>
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>The teams behind your product</span>
            <h2>Product, operations, and quality.</h2>
            <p>Specialists across product development, manufacturing, and quality support each production program.</p>
          </div>
          {/* TODO: replace initials with real staff headshots once brand photography is scheduled.
               Placeholder avatars are used deliberately here instead of stock portraits, which
               would misrepresent named individuals. */}
          <div className="grid grid-3">
            <div className="team-card">
              <div className="team-avatar">R</div>
              <div className="team-info"><h3>R&amp;D</h3><div className="team-role">Product development</div><p style={sx("font-size:13px;")}>Works with your dedicated representative to develop and refine your formula.</p></div>
            </div>
            <div className="team-card">
              <div className="team-avatar">O</div>
              <div className="team-info"><h3>Operations</h3><div className="team-role">Manufacturing</div><p style={sx("font-size:13px;")}>Coordinates production, packaging, and logistics at the Dover facility.</p></div>
            </div>
            <div className="team-card">
              <div className="team-avatar">Q</div>
              <div className="team-info"><h3>Quality</h3><div className="team-role">Testing &amp; compliance</div><p style={sx("font-size:13px;")}>Supports in-house and third-party testing and finished-product review.</p></div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container hero-grid">
          <ul style={sx('list-style:none;')}>
            <li style={sx("display:flex;gap:16px;padding:16px 0;border-bottom:1px solid hsl(var(--border));")}>
              <div style={sx("flex-shrink:0;width:32px;height:32px;border-radius:50%;background:hsl(var(--ally-orange)/.15);color:hsl(var(--ally-navy));display:flex;align-items:center;justify-content:center;font-weight:700;")}>✓</div>
              <div><h3 style={sx("font-size:14.5px;color:hsl(var(--ally-navy));margin-bottom:4px;")}>Dedicated representative</h3><p style={sx("font-size:13px;")}>Collaborate with a representative while our R&amp;D team refines your product.</p></div>
            </li>
            <li style={sx("display:flex;gap:16px;padding:16px 0;border-bottom:1px solid hsl(var(--border));")}>
              <div style={sx("flex-shrink:0;width:32px;height:32px;border-radius:50%;background:hsl(var(--ally-orange)/.15);color:hsl(var(--ally-navy));display:flex;align-items:center;justify-content:center;font-weight:700;")}>✓</div>
              <div><h3 style={sx("font-size:14.5px;color:hsl(var(--ally-navy));margin-bottom:4px;")}>Lead-time review</h3><p style={sx("font-size:13px;")}>Raw-material lead times are checked before the team provides a production date.</p></div>
            </li>
            <li style={sx("display:flex;gap:16px;padding:16px 0;border-bottom:1px solid hsl(var(--border));")}>
              <div style={sx("flex-shrink:0;width:32px;height:32px;border-radius:50%;background:hsl(var(--ally-orange)/.15);color:hsl(var(--ally-navy));display:flex;align-items:center;justify-content:center;font-weight:700;")}>✓</div>
              <div><h3 style={sx("font-size:14.5px;color:hsl(var(--ally-navy));margin-bottom:4px;")}>Flexible order planning</h3><p style={sx("font-size:13px;")}>Order requirements are based on value, formula, format, and production needs.</p></div>
            </li>
            <li style={sx("display:flex;gap:16px;padding:16px 0;")}>
              <div style={sx("flex-shrink:0;width:32px;height:32px;border-radius:50%;background:hsl(var(--ally-orange)/.15);color:hsl(var(--ally-navy));display:flex;align-items:center;justify-content:center;font-weight:700;")}>✓</div>
              <div><h3 style={sx("font-size:14.5px;color:hsl(var(--ally-navy));margin-bottom:4px;")}>Quality documentation</h3><p style={sx("font-size:13px;")}>Finished batches include a Certificate of Analysis.</p></div>
            </li>
          </ul>
          <div style={sx("background:hsl(var(--ally-navy));border-radius:var(--radius-lg);padding:36px 32px;color:#fff;")}>
            <h3 style={sx('color:#fff;margin-bottom:14px;')}>
              One manufacturing <span style={sx('color:hsl(var(--ally-orange));')}>partner</span> from idea to shipment.
            </h3>
            <p style={sx('color:hsl(0 0% 100% / .8);margin-bottom:22px;')}>Coordinate product development, production, packaging, and fulfillment with one team.</p>
            <ul style={sx('list-style:none;')}>
              <li style={sx("padding:10px 0;border-bottom:1px solid hsl(0 0% 100% / .1);font-size:13.5px;")}><span style={sx('color:hsl(var(--ally-orange));margin-right:8px;')}>→</span>Custom formulation support</li>
              <li style={sx("padding:10px 0;border-bottom:1px solid hsl(0 0% 100% / .1);font-size:13.5px;")}><span style={sx('color:hsl(var(--ally-orange));margin-right:8px;')}>→</span>Four in-house delivery formats</li>
              <li style={sx("padding:10px 0;font-size:13.5px;")}><span style={sx('color:hsl(var(--ally-orange));margin-right:8px;')}>→</span>Amazon FBA preparation available</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="section section-alt" style={sx('text-align:center;')}>
        <div className="container">
          <h2 style={sx('margin-bottom:16px;')}>Let's build something.</h2>
          <p style={sx("max-width:560px;margin:0 auto 24px;")}>
            Tell us about your formula, delivery format, packaging, and fulfillment needs.
          </p>
          <Link to="/contact" className="btn btn-primary btn-lg">Start the conversation →</Link>
        </div>
      </section>
    </section>
  );
}
