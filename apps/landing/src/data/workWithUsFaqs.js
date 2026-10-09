// [FEAT-839] The /work-with-us FAQ, and page B's version of it.
//
// A data module rather than an export of either view: a view file that also exports
// plain data defeats Vite's fast refresh (oxlint `react(only-export-components)`).

// The CONTROL's five, verbatim from the legacy page's `FAQ_DATA`
// (public/lp/index.html:1300). `/work-with-us` renders these unchanged.
export const FAQS = [
  ['What\'s your minimum order value?',
   'It\'s less about a unit count and more about order value. Typically $10k and up. Tell us your formula and format on the call and we\'ll tell you where your run lands.'],
  ['How fast can you actually deliver?',
   'Quotes usually come back within 1-3 days. Production takes 4-8 weeks, depending on raw material lead times, which we check before we give you a date. We\'d rather give you the real date than the one you want to hear, and then hit it.'],
  ['Do you help develop the formula and flavors?',
   'Yes. Simple formula development is usually included at no additional cost, while custom flavor development starts at $1,500. We’ll work with you to get the flavor right—and if we can’t deliver a result you’re happy with, we’ll refund the flavor development fee.'],
  ['Can you ship directly to Amazon FBA?',
   'Yes. We can help you label and prep to FBA requirements, then ship into the fulfillment center. You can also have it sent to your own warehouse or 3PL.'],
  ['Do you handle labels and packaging design?',
   'We design packaging in house and make sure label copy meets FDA requirements for dietary supplements. If you already have a designer, we\'ll work from their files.'],
];

// [FEAT-839 / #5705] Page B (`/work-with-us-b`) replaces two answers that would
// contradict its pricing line ("Typically $10k and up"; formula development "at no
// additional cost"). Wording: dasi.l@allynutra.com, 2026-10-02 — the second with a
// sentence break added after "$1,500".
const ANSWER_OVERRIDES = {
  "What's your minimum order value?":
    "It's less about a unit count and more about order value. Full production typically starts at $15,000. Tell us your formula and format on the call and we'll tell you where your run lands.",
  'Do you help develop the formula and flavors?':
    "Yes. Custom projects start with formulation and flavor development at $1,500. If we can't deliver a result you're happy with, we'll refund the flavor development fee.",
};

// Keyed by question so the order and the other three answers stay the control's. A
// question renamed on the control would silently stop matching, so the lookup throws
// at module load instead of shipping the contradiction this list exists to remove.
export const PAGE_B_FAQS = FAQS.map(([question, answer]) => [
  question,
  ANSWER_OVERRIDES[question] ?? answer,
]);
for (const question of Object.keys(ANSWER_OVERRIDES)) {
  if (!FAQS.some(([q]) => q === question)) {
    throw new Error(`workWithUsFaqs: the control has no FAQ "${question}" to replace`);
  }
}
