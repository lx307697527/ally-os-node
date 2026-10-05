// The email-confirmation screen (#22 email-verification slice). The link in
// the verification mail lands on this page; the token comes from the URL and
// the operator's click confirms. THE CLICK IS THE POINT: a mail scanner that
// prefetches the link only ever fetches this static page — the API's GET
// verify endpoint, which consumes the token, is called by the deliberate
// button press and by nothing else.
//
// GROUND RULE (same as SignIn): this screen decides NOTHING. It shows one of
// four states and reports the confirm intent; whether the token is good is
// the caller's business.
import type { ReactElement } from "react";
import { Link } from "react-router-dom";

import { AuthFrame } from "../../components/AuthFrame.tsx";
import { Button, Card } from "@ally/ui";

export type VerifyEmailState = "ready" | "verifying" | "verified" | "failed";

export function VerifyEmailPanel({
  state,
  error,
  onConfirm,
}: {
  state: VerifyEmailState;
  /** The server's message, verbatim. */
  error: string | null;
  onConfirm: () => void;
}): ReactElement {
  return (
    <AuthFrame data-page="B0-2" data-testid="verify-root">
      <Card padding="lg">
        <h1 className="mb-4 font-slab text-[length:var(--text-display-sm)] leading-[var(--lh-display)] font-semibold text-ink">
          Confirm your email
        </h1>
        {state === "verified" ? (
          <>
            <p className="text-ui text-ink" data-testid="verify-success">
              Your email is confirmed. Your account is ready.
            </p>
            <div className="mt-4">
              <Link to="/login" data-testid="verify-to-login" className="text-brand font-medium underline-offset-4 hover:underline">
                Go to sign in
              </Link>
            </div>
          </>
        ) : (
          <>
            <p className="text-ui text-ink">
              Click below to confirm this email address and activate your account. You can then
              sign in with the password you chose.
            </p>
            <div className="mt-[calc(var(--space-4)+var(--space-1)/2)]">
              <Button
                data-testid="verify-submit"
                variant="primary"
                disabled={state === "verifying"}
                onClick={onConfirm}
              >
                {state === "verifying" ? "Confirming…" : "Confirm my email"}
              </Button>
            </div>
            {error && (
              <div className="text-err text-ui font-medium" data-testid="verify-error">
                {error}
              </div>
            )}
          </>
        )}
      </Card>
    </AuthFrame>
  );
}
