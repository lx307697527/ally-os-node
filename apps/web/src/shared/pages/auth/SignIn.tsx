// The sign-in screen. Ported from ally-os apps/allyos SignIn.tsx (#129 slice
// 1); the social slot arrives with #22 slice 4: Google sign-in, only when the
// deployment has it configured (the enabled list is handed in by Login, which
// asked the API). The forgot-password link landed with the password-reset
// slice (#22 slice 3): the route it points at exists now.
//
// SOCIAL SLOT RENDERS NOTHING WHEN NOTHING IS ENABLED (ally-os FEAT-167): a
// button for a provider the server won't honor is an action offered that
// cannot succeed — the same defect class as a dead link. What this bundle can
// render is decided HERE (one mark is carried); what the deployment enabled
// is decided by the server and carried in. A name that survives both gates
// becomes a button; anything else is dropped at the render, the way the old
// registry's parseEnabledProviders dropped unknown keys.
//
// The unverified-email block (#22 email-verification slice): the server
// refused with "not verified", so the screen offers the one action that
// unblocks this operator — re-mailing the confirmation link. Still decides
// nothing: the resend is a reported intent, like the submission.
//
// GROUND RULE: this screen decides NOTHING. It holds the two inputs (UI state)
// and reports a submission; whether the credentials are good is the caller's
// business.
import { useState, type ReactElement, type SyntheticEvent } from "react";
import { Link } from "react-router-dom";

import { AuthFrame, AuthLabel } from "../../components/AuthFrame.tsx";
import { Button, Card, Input } from "@ally/ui";

/** Google's four-colour mark, ported from the old portal's SocialSignIn. */
function GoogleMark(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[18px] w-[18px]">
      <path fill="#4285F4" d="M23.5 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.54 5.54 0 0 1-2.4 3.63v3h3.87c2.26-2.09 3.56-5.17 3.56-8.87Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.87-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.28v3.09A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.27 14.29a7.2 7.2 0 0 1 0-4.58V6.62H1.28a12 12 0 0 0 0 10.76l3.99-3.09Z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.43-3.43C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.62l3.99 3.09C6.22 6.86 8.87 4.75 12 4.75Z" />
    </svg>
  );
}

export function SignIn({
  busy,
  error,
  notice,
  unverifiedEmail,
  resendNotice,
  resendBusy,
  onResendVerification,
  onSubmit,
  socialProviders,
  socialBusy,
  onSocialSignIn,
}: {
  busy: boolean;
  /** The server's message, verbatim. */
  error: string | null;
  /** Why the operator is here when they did not choose to be — e.g. the
   *  session-timeout watch walked them out (#129 slice 2). */
  notice: string | null;
  /** Set when the server refused a sign-in because the email is not yet
   *  confirmed (#22): the address that needs confirming. */
  unverifiedEmail: string | null;
  /** The server's answer to a resend request, verbatim. */
  resendNotice: string | null;
  resendBusy: boolean;
  onResendVerification: () => void;
  onSubmit: (credentials: { email: string; password: string }) => void;
  /** Providers the server says this deployment enables (#22). */
  socialProviders: readonly string[];
  socialBusy: boolean;
  onSocialSignIn: (provider: string) => void;
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
        {unverifiedEmail !== null && (
          <div className="mb-3" data-testid="unverified-notice">
            <div className="text-ui font-medium text-ink">
              Your email isn't confirmed yet. Confirm it to finish signing in — check your inbox
              for the link, or send it again:
            </div>
            <div className="mt-2">
              <Button
                data-testid="resend-verification"
                variant="default"
                type="button"
                disabled={resendBusy}
                onClick={onResendVerification}
              >
                {resendBusy ? "Sending…" : "Resend confirmation email"}
              </Button>
            </div>
            {resendNotice && (
              <div className="mt-2 text-ui font-medium" data-testid="resend-notice">
                {resendNotice}
              </div>
            )}
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
        {socialProviders.includes("google") && (
          // `default` and not `primary` (ally-os FEAT-442): this sits UNDER the
          // password form's own primary button — a second navy fill would claim
          // there are two main ways in. The quiet face is also what the mark's
          // colours were drawn to sit on.
          <div className="mt-4">
            <Button
              data-testid="signin-google"
              variant="default"
              type="button"
              className="w-full"
              disabled={socialBusy}
              onClick={() => {
                onSocialSignIn("google");
              }}
            >
              <GoogleMark />
              {socialBusy ? "Continuing…" : "Continue with Google"}
            </Button>
          </div>
        )}
        <div className="mt-4">
          <Link
            to="/forgot-password"
            data-testid="forgot-password-link"
            className="text-brand font-medium underline-offset-4 hover:underline"
          >
            Forgot your password?
          </Link>
        </div>
      </Card>
    </AuthFrame>
  );
}
