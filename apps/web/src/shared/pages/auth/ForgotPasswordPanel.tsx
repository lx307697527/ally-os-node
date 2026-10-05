// The forgot-password screen (#22 password-reset slice). The operator asks
// for a reset link; the page's sent state is all they get either way.
//
// GROUND RULE (same as SignIn): this screen decides NOTHING. It holds the
// one input (UI state) and reports a request; whether the address belongs to
// an account is the server's business — and its answer is deliberately the
// same for both, so the wording below must not promise mail that may not be
// coming (ally-os FEAT-566 AC-3: reaching the success state reveals nothing).
import { useState, type ReactElement, type SyntheticEvent } from "react";
import { Link } from "react-router-dom";

import { AuthFrame, AuthLabel } from "../../components/AuthFrame.tsx";
import { Button, Card, Input } from "@ally/ui";

export function ForgotPasswordPanel({
  sent,
  busy,
  error,
  onSubmit,
}: {
  /** The request was accepted. Disclosure-safe by contract: it does not
   *  claim a mail left the building. */
  sent: boolean;
  busy: boolean;
  /** The server's refusal, verbatim — a real failure (rate limit, malformed
   *  address) the operator can act on; "check your email" over it would point
   *  them at an empty inbox. */
  error: string | null;
  onSubmit: (email: string) => void;
}): ReactElement {
  const [email, setEmail] = useState("");

  function submit(e: SyntheticEvent<HTMLFormElement>): void {
    e.preventDefault();
    onSubmit(email);
  }

  return (
    <AuthFrame data-testid={sent ? "forgot-password-sent" : "forgot-password-root"}>
      <Card padding="lg">
        {sent ? (
          <>
            <h1 className="mb-4 font-slab text-[length:var(--text-display-sm)] leading-[var(--lh-display)] font-semibold text-ink">
              Check your email
            </h1>
            <p className="text-ui text-ink" data-testid="forgot-password-sent-copy">
              If that address belongs to an Ally OS account, we have sent it a link for choosing
              a new password. Open the link to continue.
            </p>
            <div className="mt-4">
              <Link
                to="/login"
                data-testid="forgot-password-to-login"
                className="text-brand font-medium underline-offset-4 hover:underline"
              >
                Back to sign in
              </Link>
            </div>
          </>
        ) : (
          <>
            <h1 className="mb-4 font-slab text-[length:var(--text-display-sm)] leading-[var(--lh-display)] font-semibold text-ink">
              Reset your password
            </h1>
            <form onSubmit={submit}>
              <AuthLabel>
                Email
                <Input
                  className="w-full"
                  data-testid="forgot-password-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                  }}
                  autoComplete="username"
                />
              </AuthLabel>
              <div className="mt-[calc(var(--space-4)+var(--space-1)/2)]">
                <Button data-testid="forgot-password-submit" variant="primary" type="submit" disabled={busy}>
                  {busy ? "Sending…" : "Send reset link"}
                </Button>
              </div>
              {error && (
                <div className="text-err text-ui font-medium" data-testid="forgot-password-error">
                  {error}
                </div>
              )}
            </form>
            <div className="mt-4">
              <Link
                to="/login"
                data-testid="forgot-password-back"
                className="text-brand font-medium underline-offset-4 hover:underline"
              >
                Back to sign in
              </Link>
            </div>
          </>
        )}
      </Card>
    </AuthFrame>
  );
}
