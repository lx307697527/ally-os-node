// #29's web half, checked as source text — the same jsdom-free shape the
// 2FA/feedback tests use. What matters: the page reads the real endpoint,
// states never lie (forbidden is said, not blanked), and the shell/route
// wiring uses the same table the rail prints.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const client = readFileSync(join(SRC, "shared", "lib", "audit-client.ts"), "utf8");
const page = readFileSync(join(SRC, "shared", "pages", "AuditLog.tsx"), "utf8");
const app = readFileSync(join(SRC, "App.tsx"), "utf8");
const rail = readFileSync(join(SRC, "shared", "shell", "rail-groups.ts"), "utf8");
const icons = readFileSync(join(SRC, "shared", "shell", "RailIcon.tsx"), "utf8");

describe("audit client (#29)", () => {
  it("reads the one endpoint with paging parameters, parsed by zod", () => {
    expect(client).toContain("`/api/audit-events?${params.toString()}`");
    expect(client).toContain("pageSchema.parse");
  });

  it("reports the failure mode instead of flattening it — 403 is not a network error", () => {
    expect(client).toContain('reason: "forbidden"');
    expect(client).toContain('reason: "unavailable"');
  });
});

describe("audit log page (#29)", () => {
  it("every state is said: loading, forbidden, unavailable, empty, and the table", () => {
    expect(page).toContain('data-testid="audit-log-loading"');
    expect(page).toContain('data-testid="audit-log-forbidden"');
    expect(page).toContain('data-testid="audit-log-unavailable"');
    expect(page).toContain('data-testid="audit-log-empty"');
    expect(page).toContain('data-testid="audit-log-table"');
  });

  it("rows carry who / did what / to what / the change payload, and append-only is said", () => {
    expect(page).toContain("append-only");
    expect(page).toContain("event.actor");
    expect(page).toContain("event.action");
    expect(page).toContain("event.target");
    expect(page).toContain("JSON.stringify(event.detail)");
  });

  it("pages in fixed steps with an exact-total footer, bounded at both ends", () => {
    expect(page).toContain("offset + PAGE_SIZE < data.total");
    expect(page).toContain("audit-log-newer");
    expect(page).toContain("audit-log-older");
    expect(page).toContain("of ${String(data.total)}");
  });
});

describe("wiring (#29)", () => {
  it("the route exists and the rail item points at it — one table, no drift", () => {
    expect(app).toContain('path="/system/audit"');
    expect(app).toContain("<AuditLog />");
    expect(rail).toContain('to: "/system/audit"');
  });

  it("the system group is no longer printed as empty — the note tells the truth", () => {
    expect(rail).not.toContain("note: \"Arrives with system administration");
    expect(rail).toContain("the audit log is here");
  });

  it("the rail row names its glyph in the set — no unnamed mark", () => {
    expect(rail).toContain('icon: "ledger"');
    expect(icons).toContain('"ledger"');
  });
});
