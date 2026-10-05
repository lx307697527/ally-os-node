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

  function submit(credentials: { email: string; password: string }): void {
    setBusy(true);
    setError(null);
    void (async () => {
      const { error: refusal } = await authClient.signIn.email(credentials);
      setBusy(false);
      if (refusal) {
        // The server's own message, verbatim. `message` is optional on the
        // wire; the fallback covers a refusal that arrived without one.
        setError(refusal.message ?? "Sign-in failed. Try again.");
        return;
      }
      navigate(returnPath, { replace: true });
    })();
  }

  return (
    <SignIn
      busy={busy}
      error={error}
      notice={sessionExpired ? "Your session expired. Sign in again to continue." : null}
      onSubmit={submit}
    />
  );
}
