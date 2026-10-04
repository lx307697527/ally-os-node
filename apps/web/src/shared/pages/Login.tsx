// The sign-in route. Ported from ally-os apps/allyos Login.tsx (#129 slice 1);
// the submit goes to better-auth's credential sign-in (#22) instead of
// Supabase.
//
// NO DESTINATION OF ITS OWN, AND THAT IS THE POINT (ally-os FEAT-068): a
// sign-in page that navigates to a hard-coded page is how everyone lands on the
// same screen whatever their role. Where a signed-in operator belongs is the
// index route's decision. The server's refusal is shown verbatim — never a
// message this app invented about a decision it did not make.
import { useState, type ReactElement } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { authClient } from "../lib/auth-client.ts";
import { returnPathFrom, type ReturnToState } from "../lib/return-to.ts";
import { SignIn } from "./auth/SignIn.tsx";

export function Login(): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  // Where RequireAuth said the operator was heading, or "/".
  const returnPath = returnPathFrom(location.state as ReturnToState | null);
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

  return <SignIn busy={busy} error={error} onSubmit={submit} />;
}
