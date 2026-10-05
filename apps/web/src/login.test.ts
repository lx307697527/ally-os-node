// The sign-in surface's discipline, checked as text — the same shape ally-os's
// auth-screens.test.ts and routes.test.ts use. The screen must decide nothing
// and own no destination, and the guard must carry where the operator was
// heading. jsdom-free on purpose: these are properties of the SOURCE.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const login = readFileSync(join(SRC, "shared", "pages", "Login.tsx"), "utf8");
const signIn = readFileSync(join(SRC, "shared", "pages", "auth", "SignIn.tsx"), "utf8");
const loginProviders = readFileSync(join(SRC, "shared", "lib", "login-providers.ts"), "utf8");
const requireAuth = readFileSync(join(SRC, "shared", "components", "RequireAuth.tsx"), "utf8");

describe("login page", () => {
  it("submits to better-auth's credential sign-in (#22)", () => {
    expect(login).toContain("authClient.signIn.email");
  });

  it("has NO destination of its own — it resumes the path RequireAuth carried", () => {
    expect(login).toContain("returnPathFrom");
    expect(login).toContain("navigate(returnPath");
    // A hard-coded destination is how everyone lands on the same screen
    // whatever their role (ally-os FEAT-068). Anything that looks like
    // navigate("/...") or navigate('...') is that mistake coming back.
    expect(login).not.toMatch(/navigate\(\s*["'`]\//);
  });

  it("shows the server's refusal verbatim, never an invented message", () => {
    expect(signIn).toContain("error");
    expect(login).toMatch(/refusal\.message/);
  });

  it("the screen decides nothing — it reports a submission", () => {
    expect(signIn).toContain("onSubmit: (credentials: { email: string; password: string }) => void");
    expect(signIn).not.toContain("authClient");
    expect(signIn).not.toContain("fetch(");
  });

  it("says why when the timeout watch walked the operator here (#129 slice 2)", () => {
    expect(login).toContain("sessionExpired");
    expect(signIn).toContain('data-testid="session-expired-notice"');
    // The notice is the watch's one message, not a second error channel: the
    // server's refusal keeps its own line.
    expect(login).toMatch(/sessionExpired \? "Your session expired/);
  });

  it("a 403 refusal means the mailbox isn't proven — the sign-in offers to re-mail the link (#22)", () => {
    expect(login).toContain("refusal.status === 403");
    expect(login).toContain("authClient.sendVerificationEmail");
    expect(signIn).toContain('data-testid="unverified-notice"');
    expect(signIn).toContain('data-testid="resend-verification"');
    // Any later sign-in outcome clears the unverified state — it is not a
    // mode this page sticks in.
    expect(login).toMatch(/setUnverifiedEmail\(null\)/);
  });

  it("the resend affordance is a reported intent — the screen still decides nothing", () => {
    expect(signIn).toContain("onResendVerification: () => void");
    expect(signIn).not.toContain("authClient");
  });
});

describe("require-auth guard", () => {
  it("sends unauthenticated visitors to /login carrying where they were heading", () => {
    expect(requireAuth).toContain('to="/login"');
    expect(requireAuth).toContain("state={{ from: location }}");
    expect(requireAuth).toContain("replace");
  });
});

describe("google sign-in slot (#22 slice 4)", () => {
  it("the screen renders no button for a provider the server has not enabled — silence, not a dead offer", () => {
    // Old system FEAT-167: a button for an unconfigured provider is an action
    // offered that cannot succeed, the same defect class as a dead link.
    expect(signIn).toContain("socialProviders.includes");
    expect(signIn).toContain('data-testid="signin-google"');
    // The screen still decides nothing: which providers exist rides in as a
    // prop from the page, which asked the server.
    expect(signIn).toContain("socialProviders: readonly string[]");
    expect(signIn).not.toContain("authClient");
    expect(signIn).not.toContain("fetch(");
  });

  it("the enabled list is the SERVER's answer, asked once and degraded to silence", () => {
    expect(login).toContain("fetchLoginProviders");
    // The lib talks to the API and zod-parses the body (external input); every
    // failure mode lands on an empty list, never on a guess or a throw.
    expect(loginProviders).toContain('"/api/auth-providers"');
    expect(loginProviders).toContain("z.object");
    expect(loginProviders).toContain("catch");
    expect(loginProviders).toContain("return []");
  });

  it("starting the social round-trip hands the browser to better-auth with the held path", () => {
    expect(login).toContain("authClient.signIn.social");
    // Success returns where RequireAuth was heading — the index route decides
    // (FEAT-068); a provider-side failure comes back HERE with the error code.
    expect(login).toContain("callbackURL: returnPath");
    expect(login).toContain('errorCallbackURL: "/login"');
  });

  it("the promise resolves only on refusal — busy is never cleared on the success path", () => {
    // "Resolves only when the redirect did NOT start" (old startOAuthSignIn):
    // on success the page is already leaving, so there is nothing to reset.
    expect(login.match(/setSocialBusy\(false\)/g)?.length).toBe(1);
    expect(login).toContain("setError(refusal.message");
  });

  it("a provider-side failure shows the server's error code, verbatim", () => {
    // The error param lands in the query string; it seeds the same error line
    // as every other refusal — no translation layer over a decision this app
    // did not make.
    expect(login).toContain('new URLSearchParams(location.search).get("error")');
  });
});
