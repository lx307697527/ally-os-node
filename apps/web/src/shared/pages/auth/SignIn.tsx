// The sign-in screen. Ported from ally-os apps/allyos SignIn.tsx (#129 slice
// 1); the social slot and the forgot-password link are NOT ported — Google
// OAuth and password reset return with the later slices of issue #22, and a
// link to a route that does not exist is a dead link.
//
// GROUND RULE: this screen decides NOTHING. It holds the two inputs (UI state)
// and reports a submission; whether the credentials are good is the caller's
// business.
import { useState, type ReactElement, type SyntheticEvent } from "react";

import { AuthFrame, AuthLabel } from "../../components/AuthFrame.tsx";
import { Button, Card, Input } from "@ally/ui";

export function SignIn({
  busy,
  error,
  notice,
  onSubmit,
}: {
  busy: boolean;
  /** The server's message, verbatim. */
  error: string | null;
  /** Why the operator is here when they did not choose to be — e.g. the
   *  session-timeout watch walked them out (#129 slice 2). */
  notice: string | null;
  onSubmit: (credentials: { email: string; password: string }) => void;
}): ReactElement {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function submit(e: SyntheticEvent<HTMLFormElement>): void {
    e.preventDefault();
    onSubmit({ email, password });
  }

  return (
    <AuthFrame data-page="B0-1" data-testid="login-root">
      <Card padding="lg">
        {/* INSIDE the card, as its first row: as the card's previous sibling the
            title floated on the page ground with nothing tying it to the form
            below. */}
        {notice && (
          <div className="mb-3 text-ui font-medium text-err" data-testid="session-expired-notice">
            {notice}
          </div>
        )}
        <h1 className="mb-4 font-slab text-[length:var(--text-display-sm)] leading-[var(--lh-display)] font-semibold text-ink">Sign in</h1>
        <form onSubmit={submit}>
          <AuthLabel>
            Email
            <Input className="w-full"
              data-testid="login-email"
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); }}
              autoComplete="username"
            />
          </AuthLabel>
          <AuthLabel className="mt-3">
            Password
            <Input className="w-full"
              data-testid="login-password"
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); }}
              autoComplete="current-password"
            />
          </AuthLabel>
          <div className="mt-[calc(var(--space-4)+var(--space-1)/2)]">
            <Button
              data-testid="login-submit"
              variant="primary"
              type="submit"
              disabled={busy}
            >
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </div>
          {error && <div className="text-err text-ui font-medium">{error}</div>}
        </form>
      </Card>
    </AuthFrame>
  );
}
