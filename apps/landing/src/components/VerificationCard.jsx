// [FEAT-780 p15 / #5558] The "Quick Verification" card inside the website chat.
//
// p14's edge function answers a message that looks like spam with a math question
// instead of a reply. This card asks it: the server's own sentence (why it is asking,
// or what was wrong with the last answer), the question, one box and "Verify". The
// answer goes back with the ORIGINAL message — ChatWidget owns that resend; this file
// is only the DOM, like LeadCard beside it.
//
// The widget remounts the card (a new `key`) for every question or verdict, so the box
// starts empty and takes focus each time: a keyboard or screen-reader visitor lands on
// the field, whose label is the question and whose description is the sentence.
import { useEffect, useId, useRef, useState } from 'react';
import { VERIFICATION_TITLE, verificationPrompt } from '../lib/leadCard.js';

/** p14 reads at most this many characters of an answer. */
const MAX_ANSWER_CHARS = 20;

export default function VerificationCard({ question, notice, failed, busy, onSubmit }) {
  const [answer, setAnswer] = useState('');
  const inputRef = useRef(null);
  const id = useId();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function submit(event) {
    event.preventDefault();
    const value = answer.trim();
    if (busy) return;
    if (!value) {
      inputRef.current?.focus();
      return;
    }
    onSubmit(value);
  }

  return (
    // aria-live="off": the card sits inside the chat's polite log. Focus moving into the
    // box already reads the question and the sentence; a failed answer is an alert.
    <form className="chat-verify" aria-labelledby={`${id}-title`} aria-live="off" onSubmit={submit} noValidate>
      <p id={`${id}-title`} className="chat-verify-title">
        {VERIFICATION_TITLE}
      </p>
      <p id={`${id}-notice`} className="chat-verify-notice" role={failed ? 'alert' : undefined}>
        {notice}
      </p>
      <div className="chat-verify-row">
        <label htmlFor={`${id}-answer`}>{verificationPrompt(question)}</label>
        <input
          id={`${id}-answer`}
          ref={inputRef}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          maxLength={MAX_ANSWER_CHARS}
          value={answer}
          // Read-only, not disabled, while the answer is checked: a disabled box drops
          // focus to <body>, and Escape (handled on the panel) would stop closing it.
          readOnly={busy}
          aria-describedby={`${id}-notice`}
          onChange={(e) => setAnswer(e.target.value)}
        />
        <button type="submit" className="chat-verify-submit" disabled={busy}>
          Verify
        </button>
      </div>
    </form>
  );
}
