// The second beat of signing in (#24): the server held the password check and
// answered twoFactorRedirect — this panel collects the proof the password
// cannot provide. Either a 6-digit TOTP code from the authenticator, or one
// of the account's backup codes (a lost device).
//
// GROUND RULE: the same as SignIn's — this screen decides NOTHING. It holds
// the input (UI state) and reports a submission with the chosen factor kind;
// whether the code is good is the caller's business, and its refusal is shown
// verbatim, never a message this app invented.
import { useState, type ReactElement, type SyntheticEvent } from "react";

import { AuthFrame, AuthLabel } from "../../components/AuthFrame.tsx";
import { Button, Card, Input } from "@ally/ui";

export type ChallengeFactor = "totp" | "backup_code";

export function TwoFactorChallenge({
  busy,
  error,
  factor,
  onFactorChange,
  onSubmit,
}: {
  busy: boolean;
  /** The server's refusal, verbatim. */
  error: string | null;
  /** Which kind of proof is being collected; the toggle between them is this
   *  panel's only decision, and it reports the choice instead of keeping it. */
  factor: ChallengeFactor;
  onFactorChange: (factor: ChallengeFactor) => void;
  onSubmit: (code: string) => void;
}): ReactElement {
  const [code, setCode] = useState("");

  function submit(e: SyntheticEvent<HTMLFormElement>): void {
    e.preventDefault();
    onSubmit(code);
  }

  const totp = factor === "totp";

  return (
    <AuthFrame data-page="B0-2" data-testid="two-factor-challenge">
      <Card padding="lg">
        <h1 className="mb-4 font-slab text-[length:var(--text-display-sm)] leading-[var(--lh-display)] font-semibold text-ink">
          Two-factor authentication
        </h1>
        <form onSubmit={submit}>
          <AuthLabel>
            {totp ? "6-digit code" : "Backup code"}
            <Input
              className="w-full"
              data-testid="two-factor-code"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
              }}
              inputMode={totp ? "numeric" : "text"}
              autoComplete={totp ? "one-time-code" : "off"}
            />
          </AuthLabel>
          <div className="mt-[calc(var(--space-4)+var(--space-1)/2)]">
            <Button
              data-testid="two-factor-submit"
              variant="primary"
              type="submit"
              disabled={busy || code.length === 0}
            >
              {busy ? "Verifying…" : "Verify"}
            </Button>
          </div>
          {error && <div className="text-err text-ui font-medium">{error}</div>}
        </form>
        <div className="mt-4">
          <Button
            data-testid="two-factor-switch"
            variant="default"
            type="button"
            onClick={() => {
              setCode("");
              onFactorChange(totp ? "backup_code" : "totp");
            }}
          >
            {totp ? "Use a backup code instead" : "Use the authenticator app instead"}
          </Button>
        </div>
      </Card>
    </AuthFrame>
  );
}
