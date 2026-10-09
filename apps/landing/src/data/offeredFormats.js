/**
 * Which finished-goods formats this marketing site PRESENTS as offered.
 *
 * ── Owner decision (Zed, 2026-09-02) [FEAT-310] ────────────────────────────
 * Tablets are NOT offered and must not appear in any customer-visible product
 * list or offering claim. The deactivation is deliberately REVERSIBLE: tablets
 * stay in `PRESENTED_FORMATS` below, keep their label and their card markup,
 * and are hidden by one entry in `DEACTIVATED_FORMATS`. Reintroducing them when
 * a tablets line launches is a one-line change here — delete `'tablets'` from
 * that array — and every consumer follows: both format grids re-render the card,
 * the grids' column counts widen, the `Format-0N` numbering renumbers itself,
 * and every prose list and the About stat pick it back up.
 *
 * This supersedes the five-format presentation introduced by the 2026-08-26
 * format-vocabulary alignment. It does NOT touch the DATA layer: the canonical
 * vocabulary is `src/modules/pricing/product-format.ts`'s `PRODUCT_FORMATS`,
 * which still contains `tablets` so historical leads and the
 * RPC's closed enum keep working. (`canisters` was named here too until
 * [FEAT-721] made it an offered format — see its entry below.) A format being un-offered is a presentation
 * fact, not a schema change. The quote form (`public/quote/index.html`) already
 * dropped tablets under the earlier 2026-08-28 decision (#1205) and is not
 * driven by this module — it has no build step, so it cannot import.
 *
 * WHY A MODULE AND NOT EDITED STRINGS. The 2026-08-26 alignment added tablets
 * by hand in nine places across six files, and the result was a site that
 * contradicted itself: Facility's Equipment section deliberately excluded
 * tablet presses while its own area-tour card two sections up claimed them, and
 * the exclusion comment had to record the disagreement as "tracked separately,
 * not fixed here". One list, derived everywhere, is what stops the next
 * reintroduction from re-earning that.
 */

/**
 * The formats hidden from every customer-visible list. Keys are this module's
 * own, matching `PRODUCT_FORMATS` spelling where one exists.
 *
 * TO REACTIVATE A FORMAT: remove it from this array. Nothing else in
 * `apps/landing` needs editing — see the module header.
 */
export const DEACTIVATED_FORMATS = ['tablets'];

/**
 * Every format this site has presentation copy for, in display order.
 *
 * A deactivated format is NOT removed from here — that is the whole point of
 * the split. `label` is the customer-facing name; `lower` is the mid-sentence
 * form (prose lists read "capsules, sachets and …", not "Capsules, Sachets").
 * "Resealable Bags" is the customer-facing name for the `pouches` key, renamed
 * in the 2026-08-26 alignment; the key stays `pouches` to match the RPC.
 */
const PRESENTED_FORMATS = [
  { key: 'capsules', label: 'Capsules', lower: 'capsules' },
  { key: 'tablets', label: 'Tablets', lower: 'tablets' },
  { key: 'sachets', label: 'Sachets', lower: 'sachets' },
  { key: 'stick_packs', label: 'Stick packs', lower: 'stick packs' },
  { key: 'pouches', label: 'Resealable Bags', lower: 'resealable bags' },
  // [FEAT-721] Offered since 2026-09-24 (owner). It was presented by the legacy
  // site — `ally-nutra`'s own `src/assets/formats/canisters.webp` is where this
  // tile's photograph comes from — and was simply never carried across, which is
  // why the header above described `canisters` as data-layer-only. That sentence
  // is superseded: it is a presented format now, and every consumer follows.
  { key: 'canisters', label: 'Tubs / Canisters / Jars', lower: 'canisters' },
];

/** Is this format currently presented as offered? */
export function isFormatOffered(key) {
  return !DEACTIVATED_FORMATS.includes(key);
}

/** The presented formats, minus the deactivated ones, in display order. */
export const OFFERED_FORMATS = PRESENTED_FORMATS.filter((f) => isFormatOffered(f.key));

/** How many formats are offered — drives both grids' column counts. */
export const OFFERED_FORMAT_COUNT = OFFERED_FORMATS.length;

/**
 * The zero-padded card number for a format, counted among the OFFERED ones.
 *
 * Returns `'02'` for sachets while tablets are deactivated and `'03'` once they
 * are back, so the `Format-0N` labels on Home and Services renumber themselves
 * instead of being renumbered by hand (which is how they came to disagree with
 * each other before). Returns `null` for a deactivated format — a caller
 * rendering a number for a card that is not shown is a bug, not a fallback.
 */
export function formatNumber(key) {
  const index = OFFERED_FORMATS.findIndex((f) => f.key === key);
  return index === -1 ? null : String(index + 1).padStart(2, '0');
}

/**
 * An English list of the offered format names, for prose.
 *
 * `lower` uses the mid-sentence form for every name; otherwise the first name
 * is capitalised and the rest are not, which is how these sentences already
 * read. `conjunction` is 'and' or 'or'. Oxford comma, matching the existing
 * copy ("capsules, sachets, stick packs, and resealable bags").
 */
export function offeredFormatList({ lower = false, conjunction = 'and' } = {}) {
  const names = OFFERED_FORMATS.map((f, i) => (lower || i > 0 ? f.lower : f.label));
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')}, ${conjunction} ${names[names.length - 1]}`;
}

/**
 * The About page's stat caption, as two middot-joined lines.
 *
 * That cell is a two-line block by design, so this splits the offered formats
 * across two balanced lines rather than letting one line wrap arbitrarily.
 * First name capitalised, the rest mid-sentence — the existing copy's shape.
 */
export function offeredFormatMiddotLines() {
  const names = OFFERED_FORMATS.map((f, i) => (i === 0 ? f.label : f.lower));
  const split = Math.ceil(names.length / 2);
  return [names.slice(0, split).join(' · '), names.slice(split).join(' · ')];
}
