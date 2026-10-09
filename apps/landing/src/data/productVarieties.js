import foilLaminatePhoto from '../assets/images/products/variety-foil-laminate.jpg';
import kraftPaperPhoto from '../assets/images/products/variety-kraft-paper.jpg';
import zipLockPhoto from '../assets/images/products/variety-zip-lock.jpg';

// Back-face explanations and varieties-popup content for the four "What we make" cards.
//
// Every variety value here traces to a specific tier/source in the Phase 0 audit
// (ally-nutra @ main, commit 1d1b8f5ada2655441f21cbf0e52b9518a3e45955, read-only —
// see the PR description for the full table). Nothing here was invented:
//   - visual: 'rung1' | 'rung2' | 'rung3' — which sourcing-ladder rung this variety's
//     visual actually used, exactly as audited.
//   - render: which VarietyVisual shape to draw for rung2 entries (undefined for
//     rung1/rung3).
//   - photo: which real photograph to show for rung1 entries (undefined otherwise).
//
// rung1 (real photograph) additions (polish/logo-and-product-photos): after an
// extensive Unsplash/Pexels search, only foil-laminate, kraft-paper, and the
// zip-lock closure had an honest, unbranded, genuinely-photographed (not
// CGI-mockup) candidate. Every other variety here — including all four capsule
// shells, matte/glossy/clear film, and the spout-cap closure — kept its existing
// rung2 SVG diagram rather than being blanked to a rung3 "no image" row: unlike
// capsule sizes (genuinely unresolved, no source at any tier), these already have
// a legitimate, tier-2-sourced illustrative diagram, and dropping that to nothing
// would be a pure regression, not an upgrade. See the PR description for the full
// list of what was searched and why each was rejected (branding, CGI-render tells,
// drug-paraphernalia-adjacent staging, or simply not found).

export const CAPSULE_VARIETIES = {
  format: 'Capsules',
  intro: 'Four shell materials, each suited to a different formulation need.',
  varieties: [
    {
      id: 'hpmc',
      name: 'HPMC (veggie)',
      spec: 'PLANT-BASED · VEGAN',
      note: 'The default choice for most brands — vegan-friendly, no animal-derived materials.',
      visual: 'rung2',
      render: { kind: 'capsule-shell', variant: 'hpmc' },
      source: 'src/components/quote/quoteOptions.ts:45 (tier 2) — corroborated src/pages/FAQs.tsx:56 (tier 3)',
    },
    {
      id: 'gelatin',
      name: 'Gelatin',
      spec: 'ANIMAL-DERIVED',
      note: 'The industry standard — widely used, cost-effective, and well understood.',
      visual: 'rung2',
      render: { kind: 'capsule-shell', variant: 'gelatin' },
      source: 'src/components/quote/quoteOptions.ts:46 (tier 2) — corroborated src/pages/FAQs.tsx:56 (tier 3)',
    },
    {
      id: 'pullulan',
      name: 'Pullulan',
      spec: 'OXYGEN-BARRIER',
      note: 'Choose this for ingredients sensitive to oxidation — it forms a tighter barrier than HPMC or gelatin.',
      visual: 'rung2',
      render: { kind: 'capsule-shell', variant: 'pullulan' },
      source: 'src/components/quote/quoteOptions.ts:47 (tier 2) — corroborated src/pages/FAQs.tsx:56, which labels it "oxygen-barrier" (tier 3)',
    },
    {
      id: 'delayed-release',
      name: 'Delayed-release',
      spec: 'TARGETED RELEASE',
      note: 'Choose this when the active ingredient needs to survive the stomach and release further along in digestion.',
      visual: 'rung2',
      render: { kind: 'capsule-shell', variant: 'delayed-release' },
      source: 'src/components/quote/quoteOptions.ts:48 (tier 2) — corroborated src/pages/FAQs.tsx:56 (tier 3)',
    },
    {
      id: 'size',
      name: 'Capsule sizes',
      // UNRESOLVED — {{CAPSULE_SIZES}}. No capsule size range exists in the company
      // repo at tier 1 or 2 (the pricing engine has no per-size cost table, and the
      // quote form has no size field). A tier-3 lead exists (src/pages/FAQs.tsx:56:
      // "sizes from 00 to 4") but the brief restricts this specific resolution to
      // tier 1/2, so this stays unresolved rather than published as fact — flagged
      // in the PR description, not published. `spec` below is the presentation-safe
      // stand-in; the token above is what a source reader should treat as ground
      // truth still owed.
      spec: 'Sizes — confirming with production.',
      visual: 'rung3',
      source: 'UNRESOLVED — flagged in PR description, not published',
    },
  ],
};

export const SACHET_VARIETIES = {
  format: 'Sachets',
  intro: 'One shared material list across sachets and stick packs — fill weight is quoted per project, not from a fixed range.',
  varieties: [
    {
      id: 'foil-laminate',
      name: 'Foil laminate',
      spec: 'MAX BARRIER',
      note: 'Best for moisture- or light-sensitive formulas — the most protective option.',
      visual: 'rung1',
      photo: foilLaminatePhoto,
      photoAlt: 'A crinkled silver foil zip-seal pouch on a plain background',
      source: 'src/components/quote/quoteOptions.ts:119 (tier 2), wired to sachets via src/components/quote/steps/PackagingStep.tsx:186-206',
    },
    {
      id: 'kraft-paper',
      name: 'Kraft paper',
      spec: 'RECYCLABLE LOOK',
      note: 'The natural-paper look brands reach for when sustainability is part of the story.',
      visual: 'rung1',
      photo: kraftPaperPhoto,
      photoAlt: 'A brown kraft-paper box-bottom pouch with a zip-seal top, on a plain background',
      source: 'quoteOptions.ts:120 (tier 2)',
    },
    {
      id: 'matte-film',
      name: 'Matte film',
      spec: 'NO GLARE',
      note: 'A soft, non-reflective finish that reads premium under most lighting.',
      visual: 'rung2',
      render: { kind: 'material-swatch', variant: 'matte-film' },
      source: 'quoteOptions.ts:121 (tier 2)',
    },
    {
      id: 'glossy-film',
      name: 'Glossy film',
      spec: 'HIGH SHINE',
      note: 'Bright, reflective, and inexpensive — a common default for DTC brands.',
      visual: 'rung2',
      render: { kind: 'material-swatch', variant: 'glossy-film' },
      source: 'quoteOptions.ts:122 (tier 2)',
    },
    {
      id: 'clear-film',
      name: 'Clear film',
      spec: 'SHOW THE PRODUCT',
      note: 'Lets the powder or granules show through — useful when color is part of the appeal.',
      visual: 'rung2',
      render: { kind: 'material-swatch', variant: 'clear-film' },
      source: 'quoteOptions.ts:123 (tier 2)',
    },
  ],
};

export const STICK_PACK_VARIETIES = {
  format: 'Stick packs',
  intro: 'The same five materials as sachets — stick packs are the narrower, single-serve format of the same packaging line.',
  varieties: SACHET_VARIETIES.varieties, // identical dropdown in PackagingStep.tsx's "flexible-single" branch
};

export const POUCH_VARIETIES = {
  format: 'Resealable Bags',
  intro: 'Four stock sizes, six fill-weight options, and the same five materials — plus a closure that matches how your customer will actually use it.',
  varieties: [
    {
      id: 'size-4x6',
      name: '4" × 6"',
      spec: 'SMALLEST STOCK SIZE',
      note: 'Sample sizes and single-serve or trial packaging.',
      visual: 'rung2',
      render: { kind: 'pouch-size', variant: '4x6', wIn: 4, hIn: 6 },
      source: 'src/components/quote/quoteOptions.ts:159 (tier 2)',
    },
    {
      id: 'size-6x9',
      name: '6" × 9"',
      spec: 'MOST COMMON',
      note: 'The size most brands start with — fits most single-consumer supply.',
      visual: 'rung2',
      render: { kind: 'pouch-size', variant: '6x9', wIn: 6, hIn: 9 },
      source: 'quoteOptions.ts:160 (tier 2)',
    },
    {
      id: 'size-8x12',
      name: '8" × 12"',
      spec: 'MULTI-SERVE',
      note: 'A step up for bulk powders or multi-week supply.',
      visual: 'rung2',
      render: { kind: 'pouch-size', variant: '8x12', wIn: 8, hIn: 12 },
      source: 'quoteOptions.ts:161 (tier 2)',
    },
    {
      id: 'size-10x14',
      name: '10" × 14"',
      spec: 'LARGEST STOCK SIZE',
      note: 'Bulk and value-size formats.',
      visual: 'rung2',
      render: { kind: 'pouch-size', variant: '10x14', wIn: 10, hIn: 14 },
      source: 'quoteOptions.ts:162 (tier 2)',
    },
    {
      id: 'closure-zip-lock',
      name: 'Zip-lock',
      spec: 'RESEALABLE',
      note: 'The default for anything a customer will dip into more than once.',
      visual: 'rung1',
      photo: zipLockPhoto,
      photoAlt: 'A hand holding a small resealable pouch, showing its zip-lock seal at the top',
      source: 'quoteOptions.ts:142 (tier 2)',
    },
    {
      id: 'closure-spout-cap',
      name: 'Spout cap',
      spec: 'POURABLE',
      note: 'For powders or liquids that need a controlled pour, not a scoop.',
      visual: 'rung2',
      render: { kind: 'pouch-closure', variant: 'spout-cap' },
      source: 'quoteOptions.ts:144 (tier 2)',
    },
  ],
};


// [FEAT-721 follow-up, owner directive 2026-09-28] The kinds popup for the
// Tubs / Canisters / Jars card — the owner asked for the popup to work on the
// new card. The kinds are the rigid-container materials the CURRENT ally-nutra
// quote engine offers (bottleTypeOptions, src/components/quote/quoteOptions.ts
// :99-105 at origin/main 335ef86e — tier 2), following exactly the pattern
// CAPSULE_VARIETIES set with capsuleTypeOptions. "Undecided" and "Other" are
// intake affordances, not kinds, and stay off the list. Notes state material
// facts only — no company claims were invented to fill rows.
export const TUBS_VARIETIES = {
  format: 'Tubs / Canisters / Jars',
  intro: 'Three container materials, each suited to a different product need.',
  varieties: [
    {
      id: 'hdpe',
      name: 'HDPE',
      spec: 'RIGID · LIGHTWEIGHT · OPAQUE',
      note: 'High-density polyethylene — rigid, lightweight, and opaque.',
      visual: 'rung3',
      source: 'quoteOptions.ts bottleTypeOptions (tier 2, main 335ef86e); material facts',
    },
    {
      id: 'pet',
      name: 'PET',
      spec: 'RIGID · CLEAR',
      note: 'Polyethylene terephthalate — rigid and clear, so the product shows through the wall.',
      visual: 'rung3',
      source: 'quoteOptions.ts bottleTypeOptions (tier 2, main 335ef86e); material facts',
    },
    {
      id: 'glass',
      name: 'Glass',
      spec: 'NON-REACTIVE',
      note: 'Non-reactive and impermeable — the contents never touch plastic.',
      visual: 'rung3',
      source: 'quoteOptions.ts bottleTypeOptions (tier 2, main 335ef86e); material facts',
    },
  ],
};

export const VARIETIES_BY_FORMAT = {
  Capsules: CAPSULE_VARIETIES,
  Sachets: SACHET_VARIETIES,
  'Stick packs': STICK_PACK_VARIETIES,
  // Key renamed with Home.jsx's PRODUCTS[].title (AN-DESIGN-001 format-vocabulary
  // alignment, 2026-08-26): "Pouches" -> "Resealable Bags", per Dasi's approved Q1 list.
  // No Tablets entry here — no sourced variety content exists for it (see Home.jsx).
  'Resealable Bags': POUCH_VARIETIES,
  // Keyed by the card's exact title — the FEAT-721 card carries no varietiesKey.
  'Tubs / Canisters / Jars': TUBS_VARIETIES,
};
