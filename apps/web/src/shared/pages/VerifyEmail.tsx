// The /verify-email route (#22 email-verification slice): where the link in
// the confirmation mail lands. It reads the token from the URL, and the API's
// verify endpoint fires on the operator's click — never on mount — so a mail
// scanner's prefetch consumes nothing (the static page is all it ever gets).
import { useState, type ReactElement } from "react";
import { useSearchParams } from "react-router-dom";

import { authClient } from "../lib/auth-client.ts";
import { VerifyEmailPanel, type VerifyEmailState } from "./auth/VerifyEmailPanel.tsx";

const NO_TOKEN_MESSAGE =
  "This confirmation link is missing its token. Request a new confirmation email and try again.";

export function VerifyEmail(): ReactElement {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<VerifyEmailState>(token === "" ? "failed" : "ready");
  const [error, setError] = useState<string | null>(token === "" ? NO_TOKEN_MESSAGE : null);

  function confirm(): void {
    setState("verifying");
    setError(null);
    void (async () => {
      const { error: refusal } = await authClient.verifyEmail({ query: { token } });
      if (refusal) {
        // The server's own message, verbatim — an expired or already-used
        // token says so itself.
        setState("failed");
        setError(refusal.message ?? "Confirmation failed. Request a new email and try again.");
        return;
      }
      setState("verified");
    })();
  }

  return <VerifyEmailPanel state={state} error={error} onConfirm={confirm} />;
}
