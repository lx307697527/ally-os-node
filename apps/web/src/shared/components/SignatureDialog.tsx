// The signature ceremony dialog (#219's frontend half, landed with its first
// real signing scenario — approving a signature level on #221's todo page).
// Part 11's ceremony: the signer re-enters their password OUTSIDE the session,
// the meaning is shown as it will be recorded (Part 11.50 signature display),
// and a fresh clientToken is minted per attempt for replay-idempotent sync.
//
// The dialog is PRESENTATIONAL + its own password field; the signing call and
// its errors belong to the consumer (the page owns the verb, the dialog owns
// the ritual). `meaning` is fixed by the approval line's configuration, so it
// is displayed, not chosen — a future consumer that lets the signer pick a
// meaning extends this component, it does not fork it.
//
// testids: sig-dialog / sig-title / sig-meaning / sig-password / sig-error /
// sig-confirm / sig-cancel.
import { useState } from "react";
import type { ReactElement } from "react";

import { Button, Card, Input, Paragraph } from "@ally/ui";

export type SignatureMeaning = "performed" | "reviewed" | "approved";

const MEANING_LABELS: Record<SignatureMeaning, string> = {
  performed: "Performed",
  reviewed: "Reviewed",
  approved: "Approved",
};

const OVERLAY =
  "fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-scrim px-6 py-13 outline-none";

export function meaningLabel(meaning: SignatureMeaning): string {
  return MEANING_LABELS[meaning];
}

export function SignatureDialog(props: {
  /** What this signature will record (Part 11.50 display), fixed by the line. */
  meaning: SignatureMeaning;
  /** True while the consumer's signing call is in flight. */
  submitting: boolean;
  /** The consumer's message for a failed attempt (wrong password, …). */
  error: string | null;
  onConfirm: (input: { password: string; clientToken: string }) => void;
  onClose: () => void;
}): ReactElement {
  const [password, setPassword] = useState("");
  const canConfirm = password !== "" && !props.submitting;

  function confirm(): void {
    if (!canConfirm) return;
    // One token per attempt: the server dedupes on it, so a retry after a lost
    // response cannot double-sign — and a retry after a REFUSED attempt is a
    // genuinely new event with its own token.
    props.onConfirm({ password, clientToken: crypto.randomUUID() });
  }

  return (
    <div className={OVERLAY} role="dialog" aria-modal="true" aria-labelledby="sig-title" data-testid="sig-dialog">
      <Card
        padding="lg"
        className="mt-13 w-full max-w-[var(--width-dialog-560)] border-t-[length:var(--border-accent-width)] border-t-accent shadow-modal"
      >
        <h2
          id="sig-title"
          className="mb-1 font-slab text-[length:var(--fs-h3)] font-semibold tracking-[var(--ls-display)] text-ink"
        >
          Sign to confirm
        </h2>
        <Paragraph className="mb-4 text-ink-soft">
          Re-enter your password to sign. The signature is recorded with your
          name and the exact time — it is a regulatory record, not a click.
        </Paragraph>

        <p className="mb-4 text-ui text-ink" data-testid="sig-meaning">
          Meaning of this signature:{" "}
          <strong>{meaningLabel(props.meaning)}</strong>
        </p>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            confirm();
          }}
        >
          <label className="mb-4 block">
            <span className="mb-1 block text-ui-sm font-semibold text-ink">Password</span>
            <Input
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              autoComplete="current-password"
              aria-label="Password"
              data-testid="sig-password"
            />
          </label>

          {props.error !== null ? (
            <Paragraph className="mb-3 text-err" data-testid="sig-error">
              {props.error}
            </Paragraph>
          ) : null}

          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" disabled={!canConfirm} data-testid="sig-confirm">
              {props.submitting ? "Signing…" : "Sign"}
            </Button>
            <Button type="button" variant="ghost" onClick={props.onClose} data-testid="sig-cancel">
              Cancel
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
