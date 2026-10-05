// The set-new-password screen (#22 password-reset slice). The reset mail's
// link lands on this page; the token comes from the URL and the operator's
// click sets the password. THE CLICK IS THE POINT: a mail scanner that
// prefetches the link only ever fetches this static page — the API's
// reset endpoint, which consumes the one-time token, is called by the
// deliberate button press and by nothing else.
//
// GROUND RULE (same as SignIn): this screen decides NOTHING. It shows one of
// four states and reports the reset intent; whether the token is good is the
// caller's business.
import { useState, type ReactElement, type SyntheticEvent } from "react";
import { Link } from "react-router-dom";

import { AuthFrame, AuthLabel } from "../../components/AuthFrame.tsx";
import { Button, Card, Input } from "@ally/ui";

export type ResetPasswordState = "ready" | "resetting" | "reset" | "failed";

export function ResetPasswordPanel({
  state,
  error,
  onReset,
}: {
  state: ResetPasswordState;
  /** The server's message, verbatim. */
  error: string | null;
  onReset: (newPassword: string) => void;
}): ReactElement {
  const [newPassword, setNewPassword] = useState("");

  function submit(e: SyntheticEvent<HTMLFormElement>): void {
    e.preventDefault();
    onReset(newPassword);
  }

  return (
    <AuthFrame data-testid="reset-password-root">
      <Card padding="lg">
        {state === "reset" ? (
          <>
            <h1 className="mb-4 font-slab text-[length:var(--text-display-sm)] leading-[var(--lh-display)] font-semibold text-ink">
              Password updated
            </h1>
            <p className="text-ui text-ink" data-testid="reset-password-success">
              Your password has been changed. Sign in with the new one.
            </p>
            <div className="mt-4">
              <Link
                to="/login"
                data-testid="reset-password-to-login"
                className="text-brand font-medium underline-offset-4 hover:underline"
              >
                Go to sign in
              </Link>
            </div>
          </>
        ) : (
          <>
            <h1 className="mb-4 font-slab text-[length:var(--text-display-sm)] leading-[var(--lh-display)] font-semibold text-ink">
              Choose a new password
            </h1>
            <form onSubmit={submit}>
              <AuthLabel>
                New password
                <Input
                  className="w-full"
                  data-testid="reset-password-password"
                  type="password"
                  required
                  value={newPassword}
                  onChange={(e) => {
                    setNewPassword(e.target.value);
                  }}
                  autoComplete="new-password"
                />
              </AuthLabel>
              <div className="mt-[calc(var(--space-4)+var(--space-1)/2)]">
                <Button
                  data-testid="reset-password-submit"
                  variant="primary"
                  type="submit"
                  disabled={state === "resetting"}
                >
                  {state === "resetting" ? "Saving…" : "Set new password"}
                </Button>
              </div>
              {error && (
                <div className="text-err text-ui font-medium" data-testid="reset-password-error">
                  {error}
                </div>
              )}
            </form>
            {state === "failed" && (
              <div className="mt-4 text-ui text-ink">
                The link may have expired or been used already.{" "}
                <Link
                  to="/forgot-password"
                  data-testid="reset-password-to-forgot"
                  className="text-brand font-medium underline-offset-4 hover:underline"
                >
                  Request a new reset email
                </Link>
              </div>
            )}
          </>
        )}
      </Card>
    </AuthFrame>
  );
}
