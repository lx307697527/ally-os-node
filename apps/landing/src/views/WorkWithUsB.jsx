import WorkWithUs from './WorkWithUs.jsx';
import { PAGE_B_FAQS } from '../data/workWithUsFaqs.js';
import { TEST_B_CONSULTATION_URL } from '../lib/iclosedBooking.js';

// [FEAT-839 / #5705] `/work-with-us-b` — page B of a Meta A/B test whose CONTROL is
// `/work-with-us`. Requested by dasi.l@allynutra.com, 2026-10-02.
//
// It is the control's view with the props below and nothing else, so every section,
// image, certificate, the VSL and the booking behaviour are the control's own. What
// differs is exactly what the test is measuring, plus what that forces:
//   * the headline and subheadline;
//   * a pricing line directly above the booking form;
//   * two FAQ answers, which on the control contradict that pricing line
//     ("Typically $10k and up"; formula development "at no additional cost") — the
//     replacement wording is the requester's;
//   * its own iClosed event, whose qualification questions differ. (UTM / click-id
//     passthrough was page B only until [FEAT-859] made the control forward them too.)
//
// Like the control it is chromeless and absent from Header and Footer, and unlike the
// control it is `noindex` and not in the sitemap (`NOINDEX_KEYS` in lib/pages.js) — a
// test variant must not compete with the page it is a variant of.

const PRICING_NOTE =
  'Custom projects start with formulation and flavor development at $1,500, plus a test run ' +
  '(typically $5,000–$7,000). Full production typically starts at $15,000.';

export default function WorkWithUsB() {
  return (
    <WorkWithUs
      headline="Custom supplement formulas, made in the USA"
      lede="Formulation, testing, and production under one roof in Dover, Delaware."
      pricingNote={PRICING_NOTE}
      faqs={PAGE_B_FAQS}
      schedulingUrl={TEST_B_CONSULTATION_URL}
    />
  );
}
