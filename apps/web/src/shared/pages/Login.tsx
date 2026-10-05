// The sign-in route. Ported from ally-os apps/allyos Login.tsx (#129 slice 1);
// the submit goes to better-auth's credential sign-in (#22) instead of
// Supabase.
//
// NO DESTINATION OF ITS OWN, AND THAT IS THE POINT (ally-os FEAT-068): a
// sign-in page that navigates to a hard-coded page is how everyone lands on the
// same screen whatever their role. Where a signed-in operator belongs is the
// index route's decision. The server's refusal is shown verbatim — never a
// message this app invented about a decision it did not make.
import { useEffect, useState, type ReactElement } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { authClient } from "../lib/auth-client.ts";
import { clearSessionExpiredNotice, peekSessionExpiredNotice } from "../lib/session-expiry.ts";
import { returnPathFrom, type ReturnToState } from "../lib/return-to.ts";
import { SignIn } from "./auth/SignIn.tsx";

export function Login(): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  // Where RequireAuth said the operator was heading, or "/".
  const returnPath = returnPathFrom(location.state as ReturnToState | null);
  // When the timeout watch walked the operator here (#129 slice 2), say why —
  // a login page with no explanation reads as the app having eaten their
  // place. Two channels, both untrusted: the one-shot sessionStorage note the
  // watch leaves at the expiry moment (survives RequireAuth winning the
  // redirect race), and the state flag the watch's own navigation carries.
  // The latch is a PURE read on purpose — dev StrictMode double-invokes state
  // initializers, and a side-effecting consume there would eat the note
  // before the latch holds; the clear happens once, after mount.
  const [sessionExpired] = useState(
    () =>
      peekSessionExpiredNotice() ||
      (location.state as ReturnToState | null)?.sessionExpired === true,
  );
  useEffect(() => {
    clearSessionExpiredNotice();
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The not-yet-confirmed address (#22 email-verification slice): the server
  // refused the sign-in with 403 EMAIL_NOT_VERIFIED, so the screen swaps in
  // the one action that unblocks this operator — re-mailing the confirmation
  // link. Any later sign-in outcome clears it.
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendNotice, setResendNotice] = useState<string | null>(null);

  function submit(credentials: { email: string; password: string }): void {
    setBusy(true);
    setError(null);
    setResendNotice(null);
    void (async () => {
      const { error: refusal } = await authClient.signIn.email(credentials);
      setBusy(false);
      if (refusal) {
        // 403 EMAIL_NOT_VERIFIED is not a dead end like a bad password: the
        // credentials were RIGHT, only the mailbox isn't proven yet. The
        // server's message still shows verbatim; the resend affordance rides
        // on top of it.
        if (refusal.status === 403) {
          setUnverifiedEmail(credentials.email);
        } else {
          setUnverifiedEmail(null);
        }
        setError(refusal.message ?? "Sign-in failed. Try again.");
        return;
      }
      setUnverifiedEmail(null);
      navigate(returnPath, { replace: true });
    })();
  }

  function resendVerification(): void {
    if (unverifiedEmail === null) return;
    setResendBusy(true);
    setError(null);
    setResendNotice(null);
    void (async () => {
      const { error: refusal } = await authClient.sendVerificationEmail({
        email: unverifiedEmail,
      });
      setResendBusy(false);
      if (refusal) {
        setError(refusal.message ?? "Could not send the email. Try again.");
        return;
      }
      // The endpoint answers the same for a known and an unknown address
      // (anti-enumeration), so the notice promises only what happened: a
      // request was sent.
      setResendNotice(
        `If ${unverifiedEmail} is an unconfirmed account, a new confirmation link is on its way.`,
      );
    })();
  }

  return (
    <SignIn
      busy={busy}
      error={error}
      notice={sessionExpired ? "Your session expired. Sign in again to continue." : null}
      unverifiedEmail={unverifiedEmail}
      resendNotice={resendNotice}
      resendBusy={resendBusy}
      onResendVerification={resendVerification}
      onSubmit={submit}
    />
  );
}
