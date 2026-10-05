// The password-reset surface's discipline (#22 password-reset slice), checked
// as text — the same source-property shape verify-email.test.ts uses,
// jsdom-free on purpose.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const forgot = readFileSync(join(SRC, "shared", "pages", "ForgotPassword.tsx"), "utf8");
const forgotPanel = readFileSync(
  join(SRC, "shared", "pages", "auth", "ForgotPasswordPanel.tsx"),
  "utf8",
);
const reset = readFileSync(join(SRC, "shared", "pages", "ResetPassword.tsx"), "utf8");
const resetPanel = readFileSync(
  join(SRC, "shared", "pages", "auth", "ResetPasswordPanel.tsx"),
  "utf8",
);
const signIn = readFileSync(join(SRC, "shared", "pages", "auth", "SignIn.tsx"), "utf8");
const app = readFileSync(join(SRC, "App.tsx"), "utf8");

describe("forgot-password page", () => {
  it("asks the API for a reset link through better-auth", () => {
    expect(forgot).toContain("authClient.requestPasswordReset");
  });

  it("the sent state is disclosure-safe — no promise that mail is on its way", () => {
    // The server answers the same for a known and an unknown address, so the
    // copy must not undo that by claiming a mail the operator may never
    // receive (ally-os FEAT-566 AC-3).
    expect(forgotPanel).toContain("If that address belongs to an Ally OS account");
    expect(forgotPanel).not.toContain("we have emailed you a link");
  });

  it("shows the server's refusal verbatim, never an invented message", () => {
    expect(forgot).toMatch(/refusal\.message/);
  });

  it("the screen decides nothing — the panel reports the request", () => {
    expect(forgotPanel).toContain("onSubmit: (email: string) => void");
    expect(forgotPanel).not.toContain("authClient");
  });

  it("both states offer the way back to sign-in", () => {
    expect(forgotPanel).toContain('to="/login"');
  });
});

describe("reset-password page", () => {
  it("reads the token from the URL and resets through better-auth", () => {
    expect(reset).toContain("useSearchParams");
    expect(reset).toContain("authClient.resetPassword");
  });

  it("the reset is user-initiated — the API call lives in the handler, never on mount", () => {
    // A mail scanner prefetching the link must consume nothing: the token is
    // one-time, and an auto-fire on mount would hand it to the first fetcher
    // that gets there.
    expect(reset).not.toContain("useEffect");
    const callSite = reset.indexOf("authClient.resetPassword");
    const handler = reset.indexOf("function reset");
    expect(handler).toBeGreaterThanOrEqual(0);
    expect(callSite).toBeGreaterThan(handler);
  });

  it("a link without a token fails with guidance instead of firing a request", () => {
    expect(reset).toContain('token === "" ? "failed" : "ready"');
    expect(reset).toContain("missing its token");
  });

  it("shows the server's refusal verbatim and offers the way back to /forgot-password", () => {
    expect(reset).toMatch(/refusal\.message/);
    expect(resetPanel).toContain('to="/forgot-password"');
  });

  it("success points at sign-in — a reset never smuggles a session in", () => {
    expect(resetPanel).toContain('to="/login"');
    expect(resetPanel).not.toContain("navigate(");
    expect(resetPanel).not.toContain("signIn");
  });

  it("the screen decides nothing — the panel reports the reset intent", () => {
    expect(resetPanel).toContain("onReset: (newPassword: string) => void");
    expect(resetPanel).not.toContain("authClient");
    expect(resetPanel).not.toContain("useSearchParams");
  });
});

describe("sign-in ↔ reset wiring", () => {
  it("sign-in links to /forgot-password — the route exists now (#22 slice 3)", () => {
    expect(signIn).toContain('to="/forgot-password"');
  });

  it("both routes are public, outside the RequireAuth group", () => {
    expect(app).toContain('<Route path="/forgot-password" element={<ForgotPassword />} />');
    expect(app).toContain('<Route path="/reset-password" element={<ResetPassword />} />');
    const publicZone = app.slice(app.indexOf('path="/login"'), app.indexOf("<RequireAuth"));
    expect(publicZone).toContain("/forgot-password");
    expect(publicZone).toContain("/reset-password");
  });
});
