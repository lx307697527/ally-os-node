// #28's web half, checked as source text — the same jsdom-free shape the
// rate-limits page tests use. What matters: the page reads the two read-face
// endpoints (fingerprint triage summary + raw ledger), states never lie
// (forbidden is said, not blanked; a filter change collapses to loading
// instead of showing another question's rows), the summary degrades alone,
// the page offers no resolution verb, and the shell/route wiring uses the
// same table the rail prints.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const client = readFileSync(join(SRC, "shared", "lib", "error-events-client.ts"), "utf8");
const page = readFileSync(join(SRC, "shared", "pages", "ErrorEvents.tsx"), "utf8");
const app = readFileSync(join(SRC, "App.tsx"), "utf8");
const rail = readFileSync(join(SRC, "shared", "shell", "rail-groups.ts"), "utf8");
const icons = readFileSync(join(SRC, "shared", "shell", "RailIcon.tsx"), "utf8");

// Prose assertions run against whitespace-collapsed source: JSX breaks lines
// where it likes, and the rendered page collapses them back.
const collapsedPage = page.replace(/\s+/g, " ");

describe("error events client (#28)", () => {
  it("reads the two endpoints — the summary with its window, the ledger with paging", () => {
    expect(client).toContain("`/api/error-events?${params.toString()}`");
    expect(client).toContain("`/api/error-events/summary?${params.toString()}`");
    // One zod parse point serves both reads: responses are external input.
    expect(client).toContain("schema.parse(await res.json())");
    expect(client).toContain("pageSchema)");
    expect(client).toContain("summarySchema)");
  });

  it("reports the failure mode instead of flattening it — 403 is not a network error", () => {
    expect(client).toContain('reason: "forbidden"');
    expect(client).toContain('reason: "unavailable"');
  });

  it("display stays open where the table is open; the filter stays closed to today's API", () => {
    // error_events.source is an open set (web today; worker/portal later, no
    // migration): the ROW schema reads it as a string so a future source's
    // rows still render; the FILTER is the narrow union the API accepts now.
    expect(client).toContain("source: z.string()");
    expect(client).toContain('"web" | "api"');
  });
});

describe("error events page (#28)", () => {
  it("every state is said: loading, forbidden, unavailable, empty, summary, and the table", () => {
    expect(page).toContain('data-testid="error-events-loading"');
    expect(page).toContain('data-testid="error-events-forbidden"');
    expect(page).toContain('data-testid="error-events-unavailable"');
    expect(page).toContain('data-testid="error-events-empty"');
    expect(page).toContain('data-testid="error-events-summary"');
    expect(page).toContain('data-testid="error-events-table"');
  });

  it("the summary degrades alone — a failed triage strip does not blank the ledger", () => {
    expect(page).toContain('data-testid="error-events-summary-unavailable"');
    expect(collapsedPage).toContain("the ledger below is current");
  });

  it("says the ledger is telemetry, not a work queue — and offers no resolution verb", () => {
    expect(collapsedPage).toContain("The ledger is telemetry");
    expect(collapsedPage).toContain("nothing here resolves anything");
    expect(page).not.toContain("Resolve");
    expect(page).not.toContain("Dismiss");
    expect(page).not.toContain("Delete");
  });

  it("the summary is the triage first screen — its rows drill the ledger by fingerprint", () => {
    expect(page).toContain('data-testid="error-events-drill"');
    expect(page).toContain("group.fingerprint");
    expect(page).toContain("group.sampleMessage");
  });

  it("the ledger answers what broke where — time, source, message, url, request id, stack on demand", () => {
    expect(page).toContain("event.message");
    expect(page).toContain("event.url");
    expect(page).toContain("event.requestId");
    expect(page).toContain("event.stack");
    expect(page).toContain('data-testid="error-events-details"');
  });

  it("a filter change collapses to loading; a page flip keeps the page", () => {
    // The placeholder guard compares the previous key's filter slots — same
    // filters means a page flip (keep the page), different filters means a
    // new question (the honest loading row).
    expect(page).toContain("key[2] === fingerprintFilter");
    expect(page).toContain("key[3] === sourceFilter");
  });

  it("every filter change resets the pager — a new question starts from the first page", () => {
    expect(page).toContain("setOffset(0)");
  });

  it("pages in fixed steps with an exact-total footer, bounded at both ends", () => {
    expect(page).toContain("offset + PAGE_SIZE < data.total");
    expect(page).toContain("error-events-newer");
    expect(page).toContain("error-events-older");
    expect(page).toContain("of ${String(data.total)}");
  });
});

describe("wiring (#28)", () => {
  it("the route exists and the rail item points at it — one table, no drift", () => {
    expect(app).toContain('path="/system/error-events"');
    expect(app).toContain("<ErrorEvents />");
    expect(rail).toContain('to: "/system/error-events"');
  });

  it("the rail row names its glyph in the set — no unnamed mark", () => {
    expect(rail).toContain('nav: "error-events", icon: "pulse"');
    expect(icons).toContain('"pulse"');
  });
});
