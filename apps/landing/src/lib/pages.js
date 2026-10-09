// Ported from the source file's hash-router IIFE (PAGE_KEYS / SERVICE_KEYS / TITLES,
// originally near the end of <body>). PAGE_KEYS is now implicit in the <Routes> list in
// App.jsx; SERVICE_KEYS and TITLES are still needed at runtime for the "any service view
// counts as active" nav-dropdown rule and the per-route <title>, so they live here.
export const SERVICE_KEYS = [
  'services',
  'contract-manufacturing',
  'private-label',
  'capsule-manufacturing',
  'vitamin-manufacturing',
  'stick-pack-manufacturing',
];

export const TITLES = {
  home: 'Ally Nutra — Contract supplement manufacturing',
  services: 'Our services | Ally Nutra',
  'contract-manufacturing': 'Contract supplement manufacturing | Ally Nutra',
  'private-label': 'Private label supplements | Ally Nutra',
  'capsule-manufacturing': 'Capsule manufacturing | Ally Nutra',
  'vitamin-manufacturing': 'Vitamin & supplement manufacturing | Ally Nutra',
  'stick-pack-manufacturing': 'Stick pack manufacturing | Ally Nutra',
  facility: 'Our facility | Ally Nutra',
  certifications: 'Certifications | Ally Nutra',
  about: 'About us | Ally Nutra',
  faq: 'Frequently asked questions | Ally Nutra',
  contact: 'Contact us | Ally Nutra',
  // [#3556] Ad landing page — routed but deliberately not in the nav.
  'work-with-us': 'Work with us | Ally Nutra',
  // [FEAT-839] Page B of the /work-with-us A/B test. Its own words, because every
  // title here must be unique (pages.test.js) — page B is noindex, so no search
  // result ever shows it.
  'work-with-us-b': 'Custom supplement formulas | Ally Nutra',
  // [FEAT-820 p2] Where /work-with-us sends a visitor after booking; chromeless too.
  'thank-you-booked': 'Your call is booked | Ally Nutra',
  // [FEAT-589 / #3902] The two legal pages — the same titles the portal's
  // copies carry, so one document does not read as two in a search result.
  'privacy-policy': 'Privacy Policy | Ally Nutra',
  'terms-of-service': 'Terms of Service | Ally Nutra',
};

// [FEAT-589 / #3902] Page keys that render WITHOUT the site Header and Footer.
// One entry: the ad landing page, which the legacy standalone page served with
// no navigation and a three-item footer of its own. `Layout` in App.jsx reads
// this; the view carries its own minimal footer. Keyed the same way TITLES is,
// so the two lookups cannot disagree about which page they are on.
export const CHROMELESS_KEYS = new Set(['work-with-us', 'work-with-us-b', 'thank-you-booked']);

// [FEAT-839] Page keys that must stay out of search: `Layout` gives them
// `<meta name="robots" content="noindex">` and no canonical link, and
// `public/sitemap.xml` leaves them out. One entry, the A/B test's page B — a test
// variant must not compete in search with the page it is a variant of.
export const NOINDEX_KEYS = new Set(['work-with-us-b']);

// [FEAT-672 / #4535] The production origin, spelled once. A canonical link must
// be absolute, and it names the PUBLIC site on every deployment — the dev and
// preview hosts serve the same pages, and pointing their canonical at
// production is what keeps a search engine from indexing them as originals.
export const SITE_ORIGIN = 'https://www.allynutra.com';

// [FEAT-672 / #4535] The canonical URL for a page key, or null for a key that
// is not a page. Keyed on TITLES because that map already IS the list of
// routed pages. `home` canonicalises to the bare origin, not `/home`: `/` is
// the address the site is known by, and the router's `/` -> `/home` redirect is
// a client-side detail. `public/sitemap.xml` lists the same set and must be
// edited with it.
export function canonicalUrl(key) {
  if (!Object.prototype.hasOwnProperty.call(TITLES, key)) return null;
  // [FEAT-839] A noindex page names no canonical: "don't index this" and "this is
  // the original" are contradictory signals to send about the same page.
  if (NOINDEX_KEYS.has(key)) return null;
  return key === 'home' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}/${key}`;
}

// Derives the page key from a react-router pathname, e.g. "/contact" -> "contact".
export function pageKeyFromPathname(pathname) {
  return pathname.replace(/^\//, '') || 'home';
}
