// The version check's discipline (#129 slice 3), checked as text (jsdom-free)
// — the same shape the shell, login and session-timeout suites use. What this
// guards is the ported ruling: the watch REPORTS a newer build, it never acts
// on it — no self-reload, no timer that can land mid-form. The one reload in
// the app is the operator's click on the banner. The production fetch wiring
// (no-store, same-origin, non-OK is not news) is text-checked here because
// faking it in a unit test would only test the fake.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// The negative assertions below police CODE, not prose — the module comments
// legitimately discuss reloads by name, and a grep over the whole file would
// convict the explanation along with the crime. Comments go, then the
// rulings are checked against what could actually execute.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const watch = stripComments(readFileSync(join(SRC, "shared", "lib", "version-watch.ts"), "utf8"));
const hook = stripComments(readFileSync(join(SRC, "shared", "lib", "use-version-check.ts"), "utf8"));
const banner = stripComments(readFileSync(join(SRC, "shared", "components", "NewVersionBanner.tsx"), "utf8"));
const app = stripComments(readFileSync(join(SRC, "App.tsx"), "utf8"));

describe("version check (#129 slice 3)", () => {
  it("nothing in the watch or the hook reloads — the banner's click is the only reload", () => {
    expect(watch).not.toMatch(/location\.|window\.open|reload/);
    expect(hook).not.toMatch(/location\.|window\.open|reload/);
    // And the reload the banner offers is a plain full page load, wired once,
    // in the app composition root.
    expect(app).toContain("<NewVersionBanner");
    expect(app.match(/location\.reload/g)?.length).toBe(1);
  });

  it("the announcement never retracts: the watch keeps its last known live id", () => {
    // live only ever moves forward (a failed or garbage check keeps what was
    // known), so the banner cannot flicker away on a bad poll.
    expect(watch).toContain("if (parsed.success) live = parsed.data.buildId;");
    expect(watch).toContain("return live !== null && live !== options.current ? live : null;");
  });

  it("polls /version.json with no-store, same-origin, and treats non-OK as no news", () => {
    expect(watch).toContain('fetch("/version.json", { cache: "no-store", credentials: "same-origin" })');
    expect(watch).toContain("if (!res.ok) throw");
  });

  it("the response body is validated before it counts as news", () => {
    expect(watch).toContain("safeParse");
  });

  it("reads its own id from the build-time define, guarded for runs without one", () => {
    expect(watch).toContain('typeof __ALLY_BUILD_ID__ === "string" ? __ALLY_BUILD_ID__ : null');
  });

  it("the cadence is the ported one: five minutes, floored at one per minute", () => {
    expect(watch).toContain("export const VERSION_CHECK_INTERVAL_MS = 5 * 60 * 1000;");
    expect(watch).toContain("export const VERSION_CHECK_MIN_GAP_MS = 60 * 1000;");
  });

  it("the hook owns one watch per mount and schedules it — no timer of its own", () => {
    expect(hook).toContain("useState(() => liveVersionWatch({ onNews: setNewBuildId }))");
    expect(hook).toContain("useEffect(() => scheduleVersionWatch(watch), [watch])");
    expect(hook).not.toContain("setInterval");
    expect(hook).not.toContain("setTimeout");
  });

  it("the banner announces politely and offers exactly one action", () => {
    expect(banner).toContain('role="status"');
    expect(banner).toContain('data-testid="new-version-banner"');
    expect(banner).toContain('data-testid="new-version-refresh"');
    expect(banner).toContain("onClick={onRefresh}");
    // No dismiss: staleness does not un-happen, and the next poll would
    // re-raise it — a close button would only be a lie the UI tells.
    expect(banner).not.toMatch(/[Oo]nClose|dismiss/i);
  });

  it("the shell mounts the check; the login page does not", () => {
    expect(app).toContain("const newBuildId = useVersionCheck();");
    // Signed-in operators only — the acceptance criterion says 在线用户.
    expect(app.match(/useVersionCheck\(\)/g)?.length).toBe(1);
  });
});
