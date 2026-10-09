// [FEAT-780 p7 / #5302] The contact card inside the website chat: the visitor's
// details become an inquiry (p3's backend, `submitLead` in ../lib/chatClient.js).
//
// It appears when the assistant reads buying intent (`intent: "lead"`), when the
// visitor asks for a person (`intent: "human"`), or when they press "Talk to a human".
// Every rule lives in `validateLead` — the quote form's rules, including the MANDATORY
// SMS consent in the form's own words (#389) — and this file is the DOM around it.
// Closing it costs nothing: the chat carries on (owner ruling Q15).
import { useId, useState } from 'react';
import { EMAIL_NOTICE_TEXT, SMS_CONSENT_TEXT, validateLead } from '../lib/leadCard.js';

export default function LeadCard({ wantsHuman, onSubmit, onDismiss }) {
  const [fields, setFields] = useState({ fullName: '', email: '', phone: '', companyName: '', smsConsent: false });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const id = useId();

  function set(name, value) {
    setFields((prev) => ({ ...prev, [name]: value }));
    if (errors[name]) setErrors((prev) => ({ ...prev, [name]: undefined }));
  }

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const checked = validateLead(fields, wantsHuman);
    if (!checked.ok) {
      setErrors(checked.errors);
      // Focus the first field that needs attention.
      const first = ['fullName', 'email', 'phone', 'smsConsent'].find((name) => checked.errors[name]);
      const target = first === 'smsConsent' ? `${id}-consent` : `${id}-${first}`;
      document.getElementById(target)?.focus();
      return;
    }
    setBusy(true);
    setFailure(null);
    const result = await onSubmit(checked.lead);
    setBusy(false);
    if (!result.ok) setFailure(result.message);
  }

  const field = (name, label, props = {}) => (
    <div className="chat-lead-field">
      <label htmlFor={`${id}-${name}`}>{label}</label>
      <input
        id={`${id}-${name}`}
        name={name}
        value={fields[name]}
        disabled={busy}
        aria-invalid={errors[name] ? 'true' : undefined}
        aria-describedby={errors[name] ? `${id}-${name}-error` : undefined}
        onChange={(e) => set(name, e.target.value)}
        {...props}
      />
      {errors[name] ? (
        <p id={`${id}-${name}-error`} className="chat-lead-error">
          {errors[name]}
        </p>
      ) : null}
    </div>
  );

  return (
    // aria-live="off": the card sits inside the chat's polite log, and a screen reader
    // should not read the whole consent paragraph aloud the moment it appears.
    <form className="chat-lead" aria-labelledby={`${id}-title`} aria-live="off" onSubmit={submit} noValidate>
      <p id={`${id}-title`} className="chat-lead-title">
        {wantsHuman ? 'Talk to a specialist' : 'Get your free quote'}
      </p>
      <p className="chat-lead-sub">
        {wantsHuman
          ? 'Leave your details and a specialist will contact you within 1 business day.'
          : 'Leave your details and a specialist will follow up with a quote within 1 business day.'}
      </p>
      {field('fullName', 'Full name', { autoComplete: 'name', maxLength: 120 })}
      {field('email', 'Email', { type: 'text', inputMode: 'email', autoComplete: 'email', maxLength: 200 })}
      {field('phone', 'Phone', { type: 'tel', autoComplete: 'tel', maxLength: 40, placeholder: '+1 555 123 4567' })}
      {field('companyName', 'Company (optional)', { autoComplete: 'organization', maxLength: 200 })}
      <div className="chat-lead-consent">
        <input
          type="checkbox"
          id={`${id}-consent`}
          checked={fields.smsConsent}
          disabled={busy}
          aria-invalid={errors.smsConsent ? 'true' : undefined}
          aria-describedby={errors.smsConsent ? `${id}-consent-error` : undefined}
          onChange={(e) => set('smsConsent', e.target.checked)}
        />
        <label htmlFor={`${id}-consent`}>{SMS_CONSENT_TEXT}</label>
      </div>
      <p className="chat-lead-notice">{EMAIL_NOTICE_TEXT}</p>
      {errors.smsConsent ? (
        <p id={`${id}-consent-error`} className="chat-lead-error">
          {errors.smsConsent}
        </p>
      ) : null}
      {failure ? (
        <p className="chat-lead-error" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="chat-lead-actions">
        <button type="button" className="chat-lead-dismiss" disabled={busy} onClick={onDismiss}>
          Not now
        </button>
        <button type="submit" className="chat-lead-submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </form>
  );
}
