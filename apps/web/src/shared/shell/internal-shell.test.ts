// The shell's markup discipline, checked as text (jsdom-free): the rail is the
// app's one navigation landmark, the top bar's tabs are derived from the rail
// table, an empty group prints WHY, and the session cluster ends in Sign out.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const shell = readFileSync(join(SRC, "shared", "shell", "InternalShell.tsx"), "utf8");
const shellFrame = readFileSync(join(SRC, "shared", "shell", "ShellFrame.tsx"), "utf8");

describe("internal shell markup", () => {
  it("the rail is the app's ONE navigation landmark", () => {
    const navs = [...shellFrame.matchAll(/<nav\b/g)];
    expect(navs.length, "ShellFrame renders exactly one <nav>").toBe(1);
    expect(shell, "InternalShell renders no <nav> of its own").not.toContain("<nav");
    expect(shellFrame).toContain('data-shell-rail');
  });

  it("region tabs come from the table and carry the region as aria-current", () => {
    expect(shell).toContain("VISIBLE_RAIL_GROUPS.map");
    expect(shell).toContain("data-region-tab={group.key}");
    expect(shell).toContain("aria-current={railRegion === group.key");
  });

  it("an empty group prints its note instead of shipping a dead link", () => {
    expect(shell).toContain("rail-group-empty-");
    expect(shell).toContain("{group.note}");
  });

  it("the session cluster ends in Sign out and names the account", () => {
    expect(shell).toContain('testId="sign-out"');
    expect(shell).toContain('data-testid="session-email"');
    expect(shell).toContain("sessionIdentityDisplay");
  });

  it("the shell fetches nothing — identity arrives as a prop", () => {
    expect(shell).not.toMatch(/authClient|fetch\(|useSession/);
  });
});
