// Lead-card copy and validation, extracted verbatim from the old repo's
// `src/lib/chatClient.js` (slice 1 of #45). The chat client itself — the
// Supabase-shaped `submitLead`/conversation plumbing and its `trackingConfig`
// dependency — is NOT ported here: it belongs to the public chat assistant
// (#48), which will rebuild it against the new API. Until then the lead card
// keeps its copy, its validation, and its phone normalization exactly as the
// old app had them, so the shapes #48 must honor stay pinned.
//
// `#48` merges this file back into its client rather than editing either copy
// in place.

/** The quote form's SMS consent, verbatim (`consentBody()` in public/quote/index.html). */
export const SMS_CONSENT_TEXT =
  'By checking this box, I expressly consent to receive transactional calls and text messages (SMS/MMS) from Ally Nutra LLC — including appointment confirmations, reminders, and account-related notifications — at the phone number provided. Consent is not required to make a purchase. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out at any time. View our Privacy Policy.';
/** The quote form's own refusal for an unticked consent box (#389). */
export const CONSENT_ERROR = 'Please agree to receive SMS updates to continue.';
/** The quote form's email notice under its consent box, verbatim — a chat lead gets the
 *  same acknowledgement and estimate emails (Q14). */
export const EMAIL_NOTICE_TEXT =
  'By submitting this form, you agree to receive email communications from Ally Nutra regarding your quote request and product updates. You can unsubscribe at any time.';

/** [FEAT-780 p15] The three sentences the verification card owns (#5042 §1.3). Every
 *  failure sentence — wrong, expired, too many tries — is the server's (p14). */
export const VERIFICATION_TITLE = 'Quick Verification';
/** p14 sends the bare sum ("3 + 4"); the widget words it. */
export function verificationPrompt(question) {
  return `What is ${question}?`;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[A-Za-z][A-Za-z0-9-]*[A-Za-z0-9]$/;
const NANP_NATIONAL = /^[2-9]\d{9}$/;

/**
 * The phone as the inquiry should store it (`+1XXXXXXXXXX` for North America, the
 * visitor's own `+…` otherwise), or `{ error }` in the quote form's words.
 */
export function normalizePhone(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { error: 'Please enter your phone number.' };
  if (/[^\d\s()+.\-]/.test(text)) return { error: 'Please enter a valid phone number.' };
  const digits = text.replace(/\D/g, '');
  if (text.startsWith('+') && !digits.startsWith('1')) {
    return digits.length >= 8 && digits.length <= 15
      ? { phone: `+${digits}` }
      : { error: 'Please enter a valid phone number.' };
  }
  // `+1…` always carries the country code; without a `+`, eleven digits starting with
  // 1 are the country code typed into the box (BUG-652's commonest mistake).
  let national = digits;
  if (text.startsWith('+') || (national.length === 11 && national.startsWith('1'))) national = national.slice(1);
  if (national.length !== 10) {
    return { error: `A +1 number has 10 digits after the country code — this one has ${national.length}.` };
  }
  if (!NANP_NATIONAL.test(national)) {
    return { error: "That doesn't look like a US or Canadian number — an area code never starts with 0 or 1." };
  }
  return { phone: `+1${national}` };
}

/**
 * Check the card. → `{ ok: true, lead }` ready for submission, or `{ ok: false,
 * errors }` keyed by field (`fullName`, `email`, `phone`, `smsConsent`).
 */
export function validateLead(fields, wantsHuman) {
  const errors = {};
  const fullName = (fields.fullName ?? '').trim();
  const email = (fields.email ?? '').trim();
  const companyName = (fields.companyName ?? '').trim();
  if (!fullName) errors.fullName = 'Please enter your name.';
  else if (fullName.length > 120) errors.fullName = 'Please keep your name to 120 characters.';
  if (!email) errors.email = 'Please enter your email address.';
  else if (!EMAIL_SHAPE.test(email)) errors.email = 'Please enter a valid email address.';
  const phone = normalizePhone(fields.phone);
  if (phone.error) errors.phone = phone.error;
  if (fields.smsConsent !== true) errors.smsConsent = CONSENT_ERROR;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    lead: {
      fullName,
      email,
      phone: phone.phone,
      companyName: companyName ? companyName.slice(0, 200) : undefined,
      smsConsent: true,
      wantsHuman: wantsHuman === true,
    },
  };
}
