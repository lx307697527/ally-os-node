// The sign-in route. Ported from ally-os apps/allyos Login.tsx (#129 slice 1);
// the submit goes to better-auth's credential sign-in (#22) instead of
// Supabase. The social slot is #22 slice 4: which providers exist is the
// SERVER's answer (GET /api/auth-providers, asked once on mount) — the same
// source of truth that honors the sign-in — so the button and the backend can
// never disagree about what this deployment offers.
//
// NO DESTINATION OF ITS OWN, AND THAT IS THE POINT (ally-os FEAT-068): a
// sign-in page that navigates to a hard-coded page is how everyone lands on the
// same screen whatever their role. Where a signed-in operator belongs is the
// index route's decision. The server's refusal is shown verbatim — never a
// message this app invented about a decision it did not make. That carries to
// the social round-trip: success comes back to the path RequireAuth was
// holding (the browser leaves before the fetch resolves, exactly like the old
// supabase-js flow); a PROVIDER-side failure comes back to /login carrying the
// server's error code in the query string, and that code is what the screen
// shows — verbatim, no translation layer.
import { useEffect, useState, type ReactElement } from "react";
import { z } from "zod";
import { useLocation, useNavigate } from "react-router-dom";

import { authClient } from "../lib/auth-client.ts";
import { fetchLoginProviders } from "../lib/login-providers.ts";
import { clearSessionExpiredNotice, peekSessionExpiredNotice } from "../lib/session-expiry.ts";
import { returnPathFrom, type ReturnToState } from "../lib/return-to.ts";
import { SignIn } from "./auth/SignIn.tsx";
import { TwoFactorChallenge, type ChallengeFactor } from "./auth/TwoFactorChallenge.tsx";

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
  // The server's error code, if the social round-trip came back with one
  // (#22 slice 4, errorCallbackURL lands here with ?error=…). Raw code,
  // verbatim — this app did not make the decision and doesn't get to dress it.
  const [error, setError] = useState<string | null>(
    () => new URLSearchParams(location.search).get("error"),
  );
  useEffect(() => {
    clearSessionExpiredNotice();
  }, []);
  const [busy, setBusy] = useState(false);
  // The not-yet-confirmed address (#22 email-verification slice): the server
  // refused the sign-in with 403 EMAIL_NOT_VERIFIED, so the screen swaps in
  // the one action that unblocks this operator — re-mailing the confirmation
  // link. Any later sign-in outcome clears it.
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendNotice, setResendNotice] = useState<string | null>(null);
  // What the deployment offers (#22 slice 4): asked once, degraded silently to
  // an empty list — no buttons is the honest render when the answer is missing.
  const [socialProviders, setSocialProviders] = useState<readonly string[]>([]);
  const [socialBusy, setSocialBusy] = useState(false);
  // #24: non-null while the server is holding a two-factor challenge for this
  // sign-in — the password beat is done, the code beat is next.
  const [challenge, setChallenge] = useState<ChallengeFactor | null>(null);
  useEffect(() => {
    void fetchLoginProviders().then(setSocialProviders);
  }, []);

  function submit(credentials: { email: string; password: string }): void {
    setBusy(true);
    setError(null);
    setResendNotice(null);
    void (async () => {
      const { data, error: refusal } = await authClient.signIn.email(credentials);
      if (refusal) {
        setBusy(false);
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
      // 2FA (#24): the password was right, but the server kept the session —
      // it answers twoFactorRedirect and holds a 10-minute challenge cookie
      // instead. The second beat collects the code (or a backup code); only
      // then is there a session and a place to resume. better-auth 1.7's
      // inferred response type doesn't model the plugin's rewritten shape
      // (runtime has it, the type doesn't), so the narrowing is a zod check —
      // the same rule this repo applies to every external payload.
      if (z.object({ twoFactorRedirect: z.literal(true) }).safeParse(data).success) {
        setBusy(false);
        setChallenge("totp");
        return;
      }
      navigate(returnPath, { replace: true });
    })();
  }

  function submitChallenge(code: string): void {
    setBusy(true);
    setError(null);
    void (async () => {
      // The factor kind is which endpoint gets the code; both create the
      // session on success and hand back to the path RequireAuth was holding.
      const { error: refusal } =
        challenge === "backup_code"
          ? await authClient.twoFactor.verifyBackupCode({ code })
          : await authClient.twoFactor.verifyTotp({ code });
      setBusy(false);
      if (refusal) {
        setError(refusal.message ?? "Sign-in failed. Try again.");
        return;
      }
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

  // Social sign-in (#22 slice 4). On success the better-auth client walks the
  // browser to Google's authorize URL itself (its redirect plugin), so this
  // promise only ever RESOLVES on a refusal — the same shape the old
  // startOAuthSignIn documented: "resolves only when the redirect did NOT
  // start". That is why busy is not cleared on the success path: there is no
  // success path to see; the page is already leaving.
  function socialSignIn(provider: string): void {
    setSocialBusy(true);
    setError(null);
    void (async () => {
      const { error: refusal } = await authClient.signIn.social({
        provider,
        // Success comes back to where the operator was heading — the index
        // route still decides (FEAT-068); a provider-side failure comes back
        // here with the server's error code in the query string.
        callbackURL: returnPath,
        errorCallbackURL: "/login",
      });
      setSocialBusy(false);
      if (refusal) {
        setError(refusal.message ?? "Sign-in failed. Try again.");
      }
    })();
  }

  if (challenge !== null) {
    return (
      <TwoFactorChallenge
        busy={busy}
        error={error}
        factor={challenge}
        onFactorChange={setChallenge}
        onSubmit={submitChallenge}
      />
    );
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
      socialProviders={socialProviders}
      socialBusy={socialBusy}
      onSocialSignIn={socialSignIn}
    />
  );
}
