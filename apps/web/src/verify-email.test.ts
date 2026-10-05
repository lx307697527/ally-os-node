// The email-confirmation surface's discipline, checked as text — the same
// source-property shape login.test.ts uses, jsdom-free on purpose.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const route = readFileSync(join(SRC, "shared", "pages", "VerifyEmail.tsx"), "utf8");
const panel = readFileSync(join(SRC, "shared", "pages", "auth", "VerifyEmailPanel.tsx"), "utf8");
const app = readFileSync(join(SRC, "App.tsx"), "utf8");

describe("verify-email page", () => {
  it("reads the token from the URL and confirms through better-auth", () => {
    expect(route).toContain("useSearchParams");
    expect(route).toContain("authClient.verifyEmail");
  });

  it("confirmation is user-initiated — the API call lives in the click handler, never on mount", () => {
    // A mail scanner prefetching the link must consume nothing: the static
    // page is all it ever fetches. An auto-fire on mount would hand the token
    // to the first fetcher that gets there.
    expect(route).not.toContain("useEffect");
    const callSite = route.indexOf("authClient.verifyEmail");
    const handler = route.indexOf("function confirm");
    expect(handler).toBeGreaterThanOrEqual(0);
    expect(callSite).toBeGreaterThan(handler);
  });

  it("a link without a token fails with guidance instead of firing a request", () => {
    expect(route).toContain('token === "" ? "failed" : "ready"');
    expect(route).toContain("missing its token");
  });

  it("shows the server's refusal verbatim, never an invented message", () => {
    expect(route).toMatch(/refusal\.message/);
  });

  it("the screen decides nothing — it reports the confirm intent", () => {
    expect(panel).toContain("onConfirm: () => void");
    expect(panel).not.toContain("authClient");
    expect(panel).not.toContain("useSearchParams");
  });

  it("success points at sign-in — verification does not smuggle a session in", () => {
    // FEAT-634 shape: confirm, then sign in. No auto-login branch exists.
    expect(panel).toContain('to="/login"');
    expect(panel).not.toContain("navigate(");
  });

  it("is routed publicly, outside the RequireAuth group", () => {
    expect(app).toContain('<Route path="/verify-email" element={<VerifyEmail />} />');
    const publicZone = app.slice(app.indexOf('path="/login"'), app.indexOf("<RequireAuth"));
    expect(publicZone).toContain("/verify-email");
  });
});
