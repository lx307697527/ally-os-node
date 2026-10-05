// Two-factor self-service (#24): the one page where an account turns TOTP on,
// banks its backup codes, re-banks a fresh batch, or turns it off.
//
// It exists for two audiences. The voluntary one manages their factor. The
// compelled one is an admin the server's enforcement gate (#232 §12: admin
// without 2FA → business routes answer 403 two_factor_required) sent here to
// comply — the page keeps that plain: setup first, management after.
//
// Enrollment shape: enable needs the account PASSWORD (a stolen tab must not
// be able to add a factor), returns the otpauth URI + the backup codes, and
// lays down an UNVERIFIED factor. The factor only counts once a real code from
// the authenticator verifies — scanning alone proves nothing. Backup codes are
// shown ONCE here and once when regenerated; the server stores them encrypted
// and burns each on use.
import { useState, type ReactElement } from "react";
import { renderSVG } from "uqr";

import { AuthLabel } from "../components/AuthFrame.tsx";
import { Button, Card, Input } from "@ally/ui";
import { authClient } from "../lib/auth-client.ts";
import { useSession } from "../lib/session.ts";

type Stage =
  | "idle" // enabled: show management; disabled: offer setup
  | "setup-verify" // enable answered: URI + codes in hand, awaiting the first real code
  | "codes-shown"; // a batch is on screen (regenerated), awaiting acknowledgement

/** The raw secret rides inside the otpauth URI; manual entry is the fallback
 *  for an authenticator that cannot scan. */
function secretFromUri(uri: string): string | null {
  try {
    return new URL(uri).searchParams.get("secret");
  } catch {
    return null;
  }
}

export function TwoFactorSettings(): ReactElement {
  const { user, loading, refreshSession } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<readonly string[]>([]);
  const [stage, setStage] = useState<Stage>("idle");

  if (loading) {
    return (
      <div className="p-6" data-testid="two-factor-settings-loading">
        Loading…
      </div>
    );
  }
  if (user === null) {
    // RequireAuth owns the signed-out case; this is just the type hole.
    return <div className="p-6">Not signed in.</div>;
  }

  const refuse = (message: string | null | undefined): void => {
    setError(message ?? "That didn't work. Try again.");
    setBusy(false);
  };

  async function startSetup(): Promise<void> {
    setBusy(true);
    setError(null);
    const { data, error: refusal } = await authClient.twoFactor.enable({ password });
    if (refusal) {
      refuse(refusal.message);
      return;
    }
    // method: "totp" 才带 totpURI/backupCodes（otp 分支需要 sendOTP 配置，
    // 服务端未开）；窄化由编译器背书，不走裸断言。
    if (data.method !== "totp") {
      refuse(null);
      return;
    }
    setTotpUri(data.totpURI);
    setBackupCodes(data.backupCodes);
    setPassword("");
    setStage("setup-verify");
  }

  async function submitSetupCode(): Promise<void> {
    setBusy(true);
    setError(null);
    const { error: refusal } = await authClient.twoFactor.verifyTotp({ code });
    if (refusal) {
      refuse(refusal.message);
      return;
    }
    setCode("");
    setBusy(false);
    // The flag flipped server-side; the cached session still says the old
    // thing. One round trip and the page — and every gate reading it — is
    // looking at the truth.
    await refreshSession();
    setStage("idle");
  }

  async function regenerate(): Promise<void> {
    setBusy(true);
    setError(null);
    const { data, error: refusal } = await authClient.twoFactor.generateBackupCodes({
      password,
    });
    if (refusal) {
      refuse(refusal.message);
      return;
    }
    setBackupCodes(data.backupCodes);
    setPassword("");
    setBusy(false);
    setStage("codes-shown");
  }

  async function disable(): Promise<void> {
    setBusy(true);
    setError(null);
    const { error: refusal } = await authClient.twoFactor.disable({ password });
    if (refusal) {
      refuse(refusal.message);
      return;
    }
    setPassword("");
    setBackupCodes([]);
    setTotpUri(null);
    setBusy(false);
    await refreshSession();
  }

  const enabled = user.twoFactorEnabled;
  const secret = totpUri === null ? null : secretFromUri(totpUri);

  let body: ReactElement;
  if (stage === "setup-verify") {
    body = (
      <>
        {totpUri !== null && (
          <div
            className="my-3 inline-block rounded-card bg-white p-2"
            data-testid="two-factor-qr"
            // uqr returns the QR as an SVG string; it encodes the otpauth URI
            // and nothing else — the same content the old system rendered.
            dangerouslySetInnerHTML={{ __html: renderSVG(totpUri) }}
          />
        )}
        {secret !== null && (
          <p className="text-ui text-ink">
            Can&apos;t scan? Enter this key manually:{" "}
            <code
              className="rounded-card border border-line bg-paper px-2 py-1 font-mono"
              data-testid="two-factor-secret"
            >
              {secret}
            </code>
          </p>
        )}
        <BackupCodesBlock codes={backupCodes} />
        <AuthLabel className="mt-3">
          6-digit code from your authenticator
          <Input
            className="w-full"
            data-testid="two-factor-setup-code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
            }}
            inputMode="numeric"
            autoComplete="one-time-code"
          />
        </AuthLabel>
        <div className="mt-[calc(var(--space-4)+var(--space-1)/2)]">
          <Button
            data-testid="two-factor-setup-verify"
            variant="primary"
            type="button"
            disabled={busy || code.length === 0}
            onClick={() => {
              void submitSetupCode();
            }}
          >
            {busy ? "Verifying…" : "Verify and turn on"}
          </Button>
        </div>
      </>
    );
  } else if (stage === "codes-shown") {
    body = (
      <>
        <BackupCodesBlock codes={backupCodes} />
        <div className="mt-3">
          <Button
            data-testid="two-factor-codes-ack"
            variant="primary"
            type="button"
            onClick={() => {
              setStage("idle");
            }}
          >
            I&apos;ve saved these codes
          </Button>
        </div>
      </>
    );
  } else if (enabled) {
    body = (
      <>
        <p className="text-ui text-ink" data-testid="two-factor-enabled-note">
          Two-factor authentication is on for this account.
        </p>
        <AuthLabel className="mt-3">
          Password
          <Input
            className="w-full"
            data-testid="two-factor-manage-password"
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            autoComplete="current-password"
          />
        </AuthLabel>
        <div className="mt-[calc(var(--space-4)+var(--space-1)/2)] flex gap-3">
          <Button
            data-testid="two-factor-regenerate"
            variant="default"
            type="button"
            disabled={busy || password.length === 0}
            onClick={() => {
              void regenerate();
            }}
          >
            {busy ? "Working…" : "New backup codes"}
          </Button>
          <Button
            data-testid="two-factor-disable"
            variant="default"
            type="button"
            disabled={busy || password.length === 0}
            onClick={() => {
              void disable();
            }}
          >
            Turn off
          </Button>
        </div>
        <p className="mt-3 text-ui text-ink">
          Turning it off puts an admin account straight back behind the enforcement gate —
          business pages lock until it is on again.
        </p>
      </>
    );
  } else {
    body = (
      <>
        <p className="text-ui text-ink">
          Your role requires two-factor authentication. Set up an authenticator app (Google
          Authenticator, 1Password, …) to continue — business pages stay locked until this is done.
        </p>
        <AuthLabel className="mt-3">
          Password
          <Input
            className="w-full"
            data-testid="two-factor-password"
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            autoComplete="current-password"
          />
        </AuthLabel>
        <div className="mt-[calc(var(--space-4)+var(--space-1)/2)]">
          <Button
            data-testid="two-factor-start"
            variant="primary"
            type="button"
            disabled={busy || password.length === 0}
            onClick={() => {
              void startSetup();
            }}
          >
            {busy ? "Starting…" : "Set up authenticator"}
          </Button>
        </div>
      </>
    );
  }

  return (
    <div className="mx-auto max-w-xl p-6" data-testid="two-factor-settings">
      <h1 className="mb-4 font-slab text-[length:var(--text-display-sm)] leading-[var(--lh-display)] font-semibold text-ink">
        Two-factor authentication
      </h1>
      <Card padding="lg">
        {body}
        {error !== null && <div className="text-err text-ui font-medium">{error}</div>}
      </Card>
    </div>
  );
}

function BackupCodesBlock({ codes }: { codes: readonly string[] }): ReactElement {
  if (codes.length === 0) return <></>;
  return (
    <div className="my-3">
      <p className="text-ui font-medium text-ink">
        Save these backup codes now — <strong>they will not be shown again</strong>. Each one signs
        you in once if you lose your authenticator, and using one burns it.
      </p>
      <ul className="mt-2 list-none p-0" data-testid="two-factor-backup-codes">
        {codes.map((c) => (
          <li key={c}>
            <code className="my-1 inline-block rounded-card border border-line bg-paper px-2 py-1 font-mono text-ui tracking-[var(--ls-meta)] text-ink">
              {c}
            </code>
          </li>
        ))}
      </ul>
    </div>
  );
}
