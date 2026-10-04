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
});

describe("require-auth guard", () => {
  it("sends unauthenticated visitors to /login carrying where they were heading", () => {
    expect(requireAuth).toContain('to="/login"');
    expect(requireAuth).toContain("state={{ from: location }}");
    expect(requireAuth).toContain("replace");
  });
});
