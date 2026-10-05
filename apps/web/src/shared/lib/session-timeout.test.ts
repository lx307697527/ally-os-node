// The timeout watch's discipline, checked as text (jsdom-free) — the same
// shape the shell and login suites use. What this guards is #129 slice 2's
// ruling: the server owns expiry, the client only counts down to the deadline
// the server published. The old system's self-run idle clock (a localStorage
// activity key, activity listeners, signOut-on-idle) must not come back, and
// a polling client must not quietly repeal the idle timeout it exists to
// enforce.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// The negative assertions below police CODE, not prose — the module comments
// legitimately discuss the retired mechanism by name, and a grep over the
// whole file would convict the explanation along with the crime. Comments go,
// then the rulings are checked against what could actually execute.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const hook = stripComments(readFileSync(join(SRC, "shared", "lib", "use-session-timeout.ts"), "utf8"));
const expiry = stripComments(readFileSync(join(SRC, "shared", "lib", "session-expiry.ts"), "utf8"));
const sessionLib = stripComments(readFileSync(join(SRC, "shared", "lib", "session.ts"), "utf8"));
const authClient = stripComments(readFileSync(join(SRC, "shared", "lib", "auth-client.ts"), "utf8"));
const warning = stripComments(readFileSync(join(SRC, "shared", "components", "SessionTimeoutWarning.tsx"), "utf8"));
const login = stripComments(readFileSync(join(SRC, "shared", "pages", "Login.tsx"), "utf8"));

describe("session timeout watch (#129 slice 2)", () => {
  it("derives everything from the server's deadline — the old idle clock stays retired", () => {
    expect(hook).toContain("useSession(");
    expect(hook).toContain("expiresAtMs");
    // The old mechanism: a local activity ledger and an idle threshold. The
    // deadline lives in the session row now, not in localStorage.
    expect(hook).not.toContain("localStorage");
    expect(expiry).not.toContain("localStorage");
    // And no activity listeners: the client never extends the session by
    // wiggling a mouse — only a server round trip does that.
    expect(hook).not.toMatch(/addEventListener/);
  });

  it("the only extension is a server round trip", () => {
    expect(hook).toContain("refreshSession");
    expect(sessionLib).toContain("refetch");
    // The watch never ends the session itself — signOut lives in session.ts
    // and is the operator's explicit act; expiry is the server's.
    expect(hook).not.toContain("signOut");
  });

  it("an expiry walks the operator to /login carrying return-to and the reason", () => {
    expect(hook).toMatch(
      /navigate\("\/login",\s*\{\s*replace: true,\s*state: \{ from: location, sessionExpired: true \}\s*\}\)/,
    );
    // The note is marked BEFORE the server verdict: whoever wins the redirect
    // race — RequireAuth on the store flipping, or the fallback navigate —
    // cannot both explain it; Login consumes the note either way.
    expect(hook).toContain("markSessionExpiredNotice()");
    expect(hook).toContain("clearSessionExpiredNotice()");
    expect(login).toContain("peekSessionExpiredNotice");
  });

  it("the client does not poll — a polling tab would never idle out", () => {
    expect(authClient).toContain("createAuthClient()");
    expect(authClient).not.toContain("refetchInterval");
  });

  it("the warning is a non-dismissible alertdialog with one way out", () => {
    expect(warning).toContain('role="alertdialog"');
    expect(warning).toContain('aria-modal="true"');
    expect(warning).not.toMatch(/onClose|onDismiss|Escape/);
    expect(warning).toContain('data-testid="session-timeout-stay"');
    expect(warning).toContain('data-testid="session-timeout-seconds"');
  });
});
