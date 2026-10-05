// The /forgot-password route (#22 password-reset slice): where the sign-in
// page's "Forgot your password?" leads. Asks the API for a reset link; the
// server answers the same for a known and an unknown address (anti-
// enumeration), so the sent state the panel shows is disclosure-safe by
// construction — the page only relays it.
import { useState, type ReactElement } from "react";

import { authClient } from "../lib/auth-client.ts";
import { ForgotPasswordPanel } from "./auth/ForgotPasswordPanel.tsx";

export function ForgotPassword(): ReactElement {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function submit(email: string): void {
    setBusy(true);
    setError(null);
    void (async () => {
      const { error: refusal } = await authClient.requestPasswordReset({ email });
      setBusy(false);
      if (refusal) {
        // The server's own message, verbatim — a rate limit or a malformed
        // address is a failure the operator can act on.
        setError(refusal.message ?? "Could not send the email. Try again.");
        return;
      }
      setSent(true);
    })();
  }

  return <ForgotPasswordPanel sent={sent} busy={busy} error={error} onSubmit={submit} />;
}
