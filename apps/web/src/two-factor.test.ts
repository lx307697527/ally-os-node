// #24's web half, checked as source text — the same jsdom-free shape the
// login/auth-screens tests use. The properties that matter are which server
// endpoints each screen talks to, that refusals are shown verbatim, and that
// no screen invents a destination of its own.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const authClient = readFileSync(join(SRC, "shared", "lib", "auth-client.ts"), "utf8");
const session = readFileSync(join(SRC, "shared", "lib", "session.ts"), "utf8");
const login = readFileSync(join(SRC, "shared", "pages", "Login.tsx"), "utf8");
const challenge = readFileSync(join(SRC, "shared", "pages", "auth", "TwoFactorChallenge.tsx"), "utf8");
const settings = readFileSync(join(SRC, "shared", "pages", "TwoFactorSettings.tsx"), "utf8");
const app = readFileSync(join(SRC, "App.tsx"), "utf8");

describe("auth client (#24)", () => {
  it("mounts the two-factor client plugin — the server's endpoints get a typed counterpart", () => {
    expect(authClient).toContain("twoFactorClient");
  });
});

describe("session mapping (#24)", () => {
  it("carries twoFactorEnabled as a definite boolean — the plugin's optional field stops at the mapping layer", () => {
    expect(session).toContain("twoFactorEnabled: data.user.twoFactorEnabled === true");
  });
});

describe("login: the second beat of signing in (#24)", () => {
  it("hands over to the challenge panel on twoFactorRedirect instead of navigating with no session", () => {
    expect(login).toContain("twoFactorRedirect: z.literal(true)");
    expect(login).toContain("TwoFactorChallenge");
  });

  it("the challenge verifies against the factor kind — totp or a backup code, both resuming the held path", () => {
    expect(login).toContain("authClient.twoFactor.verifyTotp");
    expect(login).toContain("authClient.twoFactor.verifyBackupCode");
    // Resume, never a hard-coded destination (FEAT-068, same as the first beat).
    expect(login).toContain("navigate(returnPath, { replace: true })");
  });

  it("the challenge screen decides nothing — it reports the code and the factor kind", () => {
    expect(challenge).toContain("onSubmit: (code: string) => void");
    expect(challenge).toContain("onFactorChange: (factor: ChallengeFactor) => void");
    expect(challenge).not.toContain("authClient");
    expect(challenge).not.toContain("fetch(");
  });

  it("the server's refusal is shown verbatim in both beats", () => {
    expect(login).toContain("refusal.message ?? \"Sign-in failed. Try again.\"");
  });
});

describe("two-factor settings page (#24)", () => {
  it("enable requires the password and completes only with a real code", () => {
    expect(settings).toContain("authClient.twoFactor.enable({ password })");
    expect(settings).toContain("authClient.twoFactor.verifyTotp");
    // Scanning proves nothing: the flag flips server-side only after verify,
    // and the page refetches the session so every gate reads the truth.
    expect(settings).toContain("refreshSession");
  });

  it("backup codes are shown once — regenerate burns the old batch and shows the new one", () => {
    expect(settings).toContain("authClient.twoFactor.generateBackupCodes");
    expect(settings).toContain("they will not be shown again");
  });

  it("disable needs the password too", () => {
    expect(settings).toContain("authClient.twoFactor.disable({ password })");
  });

  it("renders the otpauth URI as a QR plus the manual-entry secret", () => {
    expect(settings).toContain("renderSVG(totpUri)");
    expect(settings).toContain("secretFromUri");
  });

  it("the route exists inside the signed-in shell area", () => {
    expect(app).toContain('path="/settings/two-factor"');
    expect(app).toContain("TwoFactorSettings");
  });
});
