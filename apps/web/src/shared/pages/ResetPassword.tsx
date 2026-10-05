// The /reset-password route (#22 password-reset slice): where the link in
// the reset mail lands. It reads the token from the URL, and the API's reset
// endpoint fires on the operator's click — never on mount — so a mail
// scanner's prefetch consumes nothing (the static page is all it ever gets;
// the token is one-time and this keeps it that way).
import { useState, type ReactElement } from "react";
import { useSearchParams } from "react-router-dom";

import { authClient } from "../lib/auth-client.ts";
import { ResetPasswordPanel, type ResetPasswordState } from "./auth/ResetPasswordPanel.tsx";

const NO_TOKEN_MESSAGE =
  "This reset link is missing its token. Request a new reset email and try again.";

export function ResetPassword(): ReactElement {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<ResetPasswordState>(token === "" ? "failed" : "ready");
  const [error, setError] = useState<string | null>(token === "" ? NO_TOKEN_MESSAGE : null);

  function reset(newPassword: string): void {
    setState("resetting");
    setError(null);
    void (async () => {
      const { error: refusal } = await authClient.resetPassword({ newPassword, token });
      if (refusal) {
        // The server's own message, verbatim — an expired or already-used
        // token says so itself; the panel adds the way back to /forgot-password.
        setState("failed");
        setError(refusal.message ?? "Reset failed. Request a new link and try again.");
        return;
      }
      setState("reset");
    })();
  }

  return <ResetPasswordPanel state={state} error={error} onReset={reset} />;
}
