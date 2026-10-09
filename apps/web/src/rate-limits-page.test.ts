// #27's web half, checked as source text — the same jsdom-free shape the
// audit log tests use. What matters: the page reads the real endpoints
// (ledger + triage summary), states never lie (forbidden is said, not
// blanked), the summary degrades alone, and the shell/route wiring uses the
// same table the rail prints.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const client = readFileSync(join(SRC, "shared", "lib", "rate-limit-client.ts"), "utf8");
const page = readFileSync(join(SRC, "shared", "pages", "RateLimits.tsx"), "utf8");
const app = readFileSync(join(SRC, "App.tsx"), "utf8");
const rail = readFileSync(join(SRC, "shared", "shell", "rail-groups.ts"), "utf8");
const icons = readFileSync(join(SRC, "shared", "shell", "RailIcon.tsx"), "utf8");

// Prose assertions run against whitespace-collapsed source: JSX breaks lines
// where it likes, and the rendered page collapses them back.
const collapsedPage = page.replace(/\s+/g, " ");

describe("rate limit client (#27)", () => {
  it("reads the two endpoints — the ledger with paging, the summary with its window", () => {
    expect(client).toContain("`/api/rate-limit-denials?${params.toString()}`");
    expect(client).toContain("`/api/rate-limit-denials/summary?${params.toString()}`");
    // One zod parse point serves both reads: responses are external input.
    expect(client).toContain("schema.parse(await res.json())");
    expect(client).toContain("pageSchema)");
    expect(client).toContain("summarySchema)");
  });

  it("reports the failure mode instead of flattening it — 403 is not a network error", () => {
    expect(client).toContain('reason: "forbidden"');
    expect(client).toContain('reason: "unavailable"');
  });
});

describe("rate limits page (#27)", () => {
  it("every state is said: loading, forbidden, unavailable, empty, summary, and the table", () => {
    expect(page).toContain('data-testid="rate-limits-loading"');
    expect(page).toContain('data-testid="rate-limits-forbidden"');
    expect(page).toContain('data-testid="rate-limits-unavailable"');
    expect(page).toContain('data-testid="rate-limits-empty"');
    expect(page).toContain('data-testid="rate-limits-summary"');
    expect(page).toContain('data-testid="rate-limits-table"');
  });

  it("the summary degrades alone — a failed triage strip does not blank the ledger", () => {
    expect(page).toContain('data-testid="rate-limits-summary-unavailable"');
    expect(collapsedPage).toContain("the ledger below is current");
  });

  it("says the ledger is telemetry, not the gate — and offers no unblock verb", () => {
    expect(collapsedPage).toContain("The ledger is telemetry");
    expect(collapsedPage).toContain("nothing here unblocks anyone");
    expect(page).not.toContain("Unblock");
  });

  it("rows carry who / on what / how hard — source, action, count against limit", () => {
    expect(page).toContain("denial.identifier");
    expect(page).toContain("denial.action");
    expect(page).toContain("denial.countAtDenial");
    expect(page).toContain("denial.limitValue");
    expect(page).toContain("denial.requestId");
  });

  it("pages in fixed steps with an exact-total footer, bounded at both ends", () => {
    expect(page).toContain("offset + PAGE_SIZE < data.total");
    expect(page).toContain("rate-limits-newer");
    expect(page).toContain("rate-limits-older");
    expect(page).toContain("of ${String(data.total)}");
  });
});

describe("wiring (#27)", () => {
  it("the route exists and the rail item points at it — one table, no drift", () => {
    expect(app).toContain('path="/system/rate-limits"');
    expect(app).toContain("<RateLimits />");
    expect(rail).toContain('to: "/system/rate-limits"');
  });

  it("the rail row names its glyph in the set — no unnamed mark", () => {
    expect(rail).toContain('nav: "rate-limits", icon: "shield"');
    expect(icons).toContain('"shield"');
  });
});
