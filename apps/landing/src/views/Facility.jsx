import { Link } from 'react-router-dom';
import { sx } from '../lib/styleString.js';
import { hideAndTint, hideOnly } from '../lib/imgFallback.js';
import { scrollToId } from '../lib/scrollToId.js';

import rawMaterialWarehouse from '../assets/images/raw-material-warehouse.jpg';
import gowningAirlock from '../assets/images/gowning-airlock.jpg';
import rawMaterialIntake from '../assets/images/raw-material-intake.jpg';
import facilityExterior from '../assets/images/source-facility-exterior.webp';
import cleanroomCorridor from '../assets/images/source-cleanroom-corridor.webp';
import stickPackFillingLine from '../assets/images/source-stick-pack-filling-line.webp';
import finishedGoodsWarehouse from '../assets/images/vitamin-hero-warehouse.webp';
// Real Ally Nutra equipment photos (AN-DESIGN-001 sweep, Item 5), copied
// read-only from Ally-Nutra-LLC-New/ally-nutra. njp2500 was already in this
// app (previously a standalone figure below the icon cards; now the
// Capsule encapsulators card photo instead). encapsulation-machine.jpg
// (the former second standalone figure) is deliberately not reused as a
// second card — same equipment type as njp2500, would read as one machine
// shown twice.
import njp2500 from '../assets/images/njp-2500-capsule-machine.jpg';
// Owner-delivered QC lab photography from the approved Drive folder.
import qcHplcStack from '../assets/images/qc-hplc-stack.jpg';
import qcAutosamplerRacks from '../assets/images/qc-autosampler-racks.jpg';

import analysisCabinet from '../assets/images/facility-analysis-cabinet.webp';

export default function Facility() {
  return (
    <section aria-labelledby="facility-h1">
      <section className="hero on-navy">
        <div className="container hero-grid">
          <div>
            <span className="eyebrow on-dark">Our facility</span>
            <h1 id="facility-h1" style={sx('color:#fff;margin-top:14px;')}>Supplement manufacturing in Dover, Delaware.</h1>
            <p style={sx("color:hsl(0 0% 100% / .78);margin:18px 0 0;max-width:480px;")}>
              Our FDA-registered, NSF/ANSI 455-2 certified facility supports blending,
              encapsulation, bottling, packaging, and quality control.
            </p>
            <div className="hero-ctas">
              <Link to="/contact" className="btn btn-primary btn-lg">Contact our team →</Link>
              <a href="#facility-areas" className="btn btn-outline-light btn-lg" onClick={scrollToId('facility-areas')}>
                Explore the facility
              </a>
            </div>
          </div>
          <div className="photo ratio-4x3">
            <img src={facilityExterior} width="1200" height="670" alt="Exterior of Ally Nutra's Dover, Delaware manufacturing facility, the Ally Nutra sign on the warehouse wall" loading="lazy" onError={hideAndTint} />
          </div>
        </div>
      </section>

      {/* CLAIMS REMEDIATION — was 4 stats. "50,000 Sq ft facility" removed:
          the only two real, sourced facility-size figures found in either
          repo are ~20,000 sq ft (a real, dated news article and the site's
          own content-generation prompt) plus a since-2024 7,000 sq ft grant
          expansion — neither confirms today's true figure, so stating any
          number here would repeat the original mistake rather than fix it.
          "12+ Production lines" removed: no source anywhere. Left at 2 real
          stats rather than backfilling; see apps/landing/CLAUDE.md. */}
      <section className="section-tight" style={sx('border-bottom:1px solid hsl(var(--border));')}>
        <div className="container simple-stats">
          <div className="simple-stat"><div className="num">NSF</div><div className="lbl">ANSI 455-2 certified</div></div>
          <div className="simple-stat"><div className="num">100%</div><div className="lbl">Made in USA</div></div>
        </div>
      </section>

      <section className="section">
        <div className="container hero-grid">
          <div>
            <span className="eyebrow">Facility overview</span>
            <h2 style={sx('margin:14px 0 16px;')}>Built for brands that take quality seriously.</h2>
            <p style={sx('margin-bottom:24px;')}>
              Our Dover facility brings manufacturing and quality operations together under one
              roof. The production floor includes blending, capsule filling, bottling, packaging,
              cleanroom space, and quality-control areas.
            </p>
            <ul className="bullet-list">
              <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>Capsule filling and bottling equipment</li>
              <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>V-blending for powder formulas</li>
              <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>On-site QC laboratory for in-process testing</li>
              <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>Cleanroom production space</li>
            </ul>
          </div>
          <div className="card" style={sx('padding:0;overflow:hidden;')}>
            <div className="grid" style={sx("grid-template-columns:1.2fr 1fr 1fr;grid-template-rows:1fr 1fr;gap:1px;background:hsl(var(--border));")}>
              <div style={sx("grid-row:span 2;background:hsl(var(--ally-navy));color:hsl(var(--ally-orange));display:flex;align-items:center;justify-content:center;text-align:center;font-size:12px;font-weight:600;padding:16px;")}>Production floor</div>
              <div style={sx("background:hsl(var(--muted));display:flex;align-items:center;justify-content:center;text-align:center;font-size:12px;font-weight:600;color:hsl(var(--ally-navy));padding:16px;")}>QC lab</div>
              <div style={sx("background:hsl(var(--ally-orange)/.15);display:flex;align-items:center;justify-content:center;text-align:center;font-size:12px;font-weight:600;color:hsl(var(--ally-navy));padding:16px;")}>Raw storage</div>
              <div style={sx("background:hsl(var(--ally-orange)/.15);display:flex;align-items:center;justify-content:center;text-align:center;font-size:12px;font-weight:600;color:hsl(var(--ally-navy));padding:16px;")}>Packaging</div>
              <div style={sx("background:hsl(var(--muted));display:flex;align-items:center;justify-content:center;text-align:center;font-size:12px;font-weight:600;color:hsl(var(--ally-navy));padding:16px;")}>Finished goods</div>
            </div>
          </div>
        </div>
      </section>

      <section className="section section-alt" id="facility-areas">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>Facility areas</span>
            <h2>A tour of where your product is made.</h2>
            <p>A look at the spaces that support manufacturing, quality, packaging, and shipping.</p>
          </div>
          <div className="grid grid-3">
            <div className="area-card">
              <div className="photo ratio-4x3"><img src={rawMaterialIntake} width="900" height="675" alt="Incoming raw material and packaging staged on the Ally Nutra receiving floor: a pallet of stacked Pretium packaging cartons, fibre and poly ingredient drums with lot labels, and cased components awaiting sampling" loading="lazy" onError={hideAndTint} /></div>
              <div className="area-body">
                <div className="area-tag">Receiving</div>
                <h3 style={sx("font-size:17px;margin-bottom:8px;")}>Raw material intake</h3>
                <p style={sx("font-size:13px;margin-bottom:12px;")}>Incoming ingredients and packaging are staged before they move into production.</p>
              </div>
            </div>
            <div className="area-card">
              <div className="photo ratio-4x3"><img src={rawMaterialWarehouse} width="900" height="675" alt="An aisle of Ally Nutra's raw material warehouse: blue and orange pallet racking stocked with shrink-wrapped cartons and fibre drums, with yellow aisle markings on the floor" loading="lazy" onError={hideAndTint} /></div>
              <div className="area-body">
                <div className="area-tag">Storage</div>
                <h3 style={sx("font-size:17px;margin-bottom:8px;")}>Raw material warehouse</h3>
                <p style={sx("font-size:13px;margin-bottom:12px;")}>Raw materials are stored before blending and manufacturing.</p>
              </div>
            </div>
            <div className="area-card">
              <div className="photo ratio-4x3"><img src={cleanroomCorridor} width="1000" height="1000" alt="Clean production corridor with a gowned Ally Nutra team member" loading="lazy" onError={hideAndTint} /></div>
              <div className="area-body">
                <div className="area-tag">Production</div>
                <h3 style={sx("font-size:17px;margin-bottom:8px;")}>Blending &amp; manufacturing</h3>
                {/* [FEAT-310] "tablet presses" REMOVED. This card claimed presses two sections
                    above an Equipment section that deliberately excludes them — the
                    self-contradiction its own comment recorded as "tracked separately,
                    not fixed here". The owner's decision removes the tablets OFFERING;
                    whether a press physically exists in Dover is still unconfirmed, so
                    the claim is dropped, not restated. Flagged for owner confirmation. */}
                <p style={sx("font-size:13px;margin-bottom:12px;")}>V-blending, capsule filling, and powder manufacturing take place on the production floor.</p>
                <span className="chip">V-blender</span> <span className="chip">Encapsulator</span>
              </div>
            </div>
            <div className="area-card">
              <div className="photo ratio-4x3"><img src={qcAutosamplerRacks} width="735" height="551" alt="An Agilent SPS 4 autosampler holding labelled racks of prepared sample tubes" loading="lazy" onError={hideAndTint} /></div>
              <div className="area-body">
                <div className="area-tag">Quality</div>
                <h3 style={sx("font-size:17px;margin-bottom:8px;")}>QC laboratory</h3>
                <p style={sx("font-size:13px;margin-bottom:12px;")}>The quality team performs in-process checks and reviews finished products.</p>
              </div>
            </div>
            <div className="area-card">
              <div className="photo ratio-4x3"><img src={stickPackFillingLine} width="900" height="600" alt="Stick-pack filling and sealing equipment from the approved AllyNutra source site" loading="lazy" onError={hideAndTint} /></div>
              <div className="area-body">
                <div className="area-tag">Packaging</div>
                <h3 style={sx("font-size:17px;margin-bottom:8px;")}>Bottling &amp; packaging</h3>
                <p style={sx("font-size:13px;margin-bottom:12px;")}>Finished products are filled, labeled, and packaged for their sales channel.</p>
              </div>
            </div>
            <div className="area-card">
              <div className="photo ratio-4x3"><img src={finishedGoodsWarehouse} width="1148" height="861" alt="Ally Nutra warehouse racking stocked with palletized inventory, and the packing bench with a label printer and scale" loading="lazy" onError={hideAndTint} /></div>
              <div className="area-body">
                <div className="area-tag">Logistics</div>
                <h3 style={sx("font-size:17px;margin-bottom:8px;")}>Finished goods &amp; shipping</h3>
                <p style={sx("font-size:13px;margin-bottom:12px;")}>Finished goods can ship to your warehouse, 3PL, or Amazon FBA.</p>
                <span className="chip">FBA prep</span> <span className="chip">Direct ship</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-header">
            <span className="eyebrow" style={sx('justify-content:center;')}>Equipment</span>
            <h2>Manufacturing and quality equipment.</h2>
            <p>Capsule filling, bottling, V-blending, and quality-control equipment support production in our Dover facility.</p>
          </div>
          {/* AN-DESIGN-001 sweep, Item 5 — real equipment photography only:
              one distinct, correctly-labelled photo per card, no icons, no
              stock substitutes, no photo reused across cards. Of the six
              equipment types this section used to list as icon cards, only
              three have real Ally Nutra photography that actually shows the
              named machine (search covered every image in both repos — see
              apps/landing/CLAUDE.md). Tablet presses is deliberately absent
              from both the cards and the text line below — not an
              oversight, excluded pending the live-site tablets
              inconsistency (tracked separately, not fixed here). */}
          <div className="grid grid-3">
            <div className="area-card">
              <div className="photo ratio-4x3"><img src={njp2500} width="669" height="1200" alt="An NJP-2500 automatic capsule filling machine on the production floor" loading="lazy" onError={hideAndTint} /></div>
              <div className="area-body">
                <div className="area-tag">Encapsulation</div>
                <h3 style={sx("font-size:17px;margin-bottom:8px;")}>Capsule encapsulators</h3>
                <p style={sx("font-size:13px;margin-bottom:12px;")}>Automatic capsule filling equipment for sizes 00 through 4.</p>
              </div>
            </div>
            <div className="area-card">
              {/* [owner directive 2026-09-16] This card used to be "Bottling / Bottle counter
                  & filler" over a `Photography pending` block, because no honest bottling
                  photograph existed. The owner has directed that no non-product slot may
                  render empty, so the slot is filled — but NOT with a picture of a bottling
                  line, because no such photograph exists in any approved source. Still none.

                  The card is therefore retitled to the equipment this photograph actually
                  shows: a ConductScience MCGS bench analysis cabinet in the on-site lab. The
                  alternative — leaving "Bottle counter & filler" over a picture of a lab
                  cabinet — is the exact caption/subject mismatch that put an AI-generated
                  "bottling line" on this page for weeks, and this section's own rule is "one
                  distinct, correctly-labelled photo per card".

                  THE BOTTLING CAPABILITY CLAIM IS NOT DROPPED: it moves into this section's
                  intro paragraph above, so the page still states it. Restore this card when a
                  real bottle-counter/filler photograph is delivered — it remains on
                  `docs/photography-shot-list.md` as item 5. */}
              <div className="photo ratio-4x3">
                <img
                  src={analysisCabinet}
                  width="786"
                  height="590"
                  alt="A ConductScience MCGS bench analysis cabinet in Ally Nutra's on-site QC lab, its touchscreen controller and mesh-floored sample chamber visible"
                  loading="lazy"
                  onError={hideAndTint}
                />
              </div>
              <div className="area-body">
                <div className="area-tag">Analysis</div>
                <h3 style={sx("font-size:17px;margin-bottom:8px;")}>Bench analysis cabinet</h3>
                <p style={sx("font-size:13px;margin-bottom:12px;")}>Enclosed benchtop equipment used by the quality team for sample work.</p>
              </div>
            </div>
            <div className="area-card">
              <div className="photo ratio-4x3"><img src={qcHplcStack} width="737" height="553" alt="An Agilent 1100 Series HPLC stack with its two solvent channels and sample tray in the on-site QC lab" loading="lazy" onError={hideAndTint} /></div>
              <div className="area-body">
                <div className="area-tag">Quality</div>
                <h3 style={sx("font-size:17px;margin-bottom:8px;")}>QC lab instruments</h3>
                <p style={sx("font-size:13px;margin-bottom:12px;")}>Laboratory instruments support quality checks and product review.</p>
              </div>
            </div>
          </div>
          <p style={sx('margin-top:20px;text-align:center;font-size:13px;color:hsl(var(--muted-foreground));')}>Also on the production floor: V-blenders &amp; ribbon mixers, and powder filling lines.</p>
        </div>
      </section>

      <section className="section section-rule">
        <div className="container hero-grid">
          <div>
            <span className="eyebrow">Compliance &amp; clean rooms</span>
            <h2 style={sx('margin:14px 0 16px;')}>Certified manufacturing controls.</h2>
            <p style={sx('margin-bottom:20px;')}>
              NSF/ANSI 455-2 certification covers Good Manufacturing Practice controls for
              dietary supplement manufacturing.
            </p>
            <ul style={sx('list-style:none;')}>
              <li style={sx("padding:16px 0;border-bottom:1px solid hsl(var(--border));")}><h3 style={sx("color:hsl(var(--ally-orange-ink));font-size:15px;margin-bottom:6px;")}>NSF/ANSI 455-2</h3><p style={sx("font-size:13px;")}>Third-party certification for dietary supplement Good Manufacturing Practices.</p></li>
              <li style={sx("padding:16px 0;border-bottom:1px solid hsl(var(--border));")}><h3 style={sx("color:hsl(var(--ally-orange-ink));font-size:15px;margin-bottom:6px;")}>FDA registered</h3><p style={sx("font-size:13px;")}>The Dover dietary supplement manufacturing facility is registered with the FDA.</p></li>
              <li style={sx('padding:16px 0;')}><h3 style={sx("color:hsl(var(--ally-orange-ink));font-size:15px;margin-bottom:6px;")}>Quality checks</h3><p style={sx("font-size:13px;")}>Quality controls support production and finished-product review.</p></li>
            </ul>
          </div>
          <div>
            {/* CLAIMS REMEDIATION — the ISO 8/ISO 8/ISO 7 cleanroom
                classification box that sat below this photo was removed
                entirely: no "ISO 8" or "ISO 7" classification string exists
                anywhere in ally-nutra (the only real "ISO" claim there is
                ISO-9001 employee training, an unrelated quality-management
                standard). Its sole content was these three unsourced
                classifications, so the box itself is gone rather than left
                with empty labels. */}
            <div className="photo ratio-4x3">
              <img src={gowningAirlock} width="1100" height="825" alt="Ally Nutra's gowning room: disposable gowns on a rail, stainless lockers and bench, and the airlock pass-through doors into the production area, with an operator putting on shoe covers" loading="lazy" onError={hideOnly} />
            </div>
          </div>
        </div>
      </section>

      <section className="section" style={sx('text-align:center;')}>
        <div className="container">
          <span className="eyebrow" style={sx('justify-content:center;')}>Visit us</span>
          <h2 style={sx("margin:14px auto 16px;max-width:600px;")}>Find us in Dover, Delaware.</h2>
          <p style={sx("max-width:560px;margin:0 auto 24px;")}>Full address, hours, directions, and contact information are available on our contact page.</p>
          <Link to="/contact" className="btn btn-primary btn-lg">Go to contact →</Link>
        </div>
      </section>
    </section>
  );
}
