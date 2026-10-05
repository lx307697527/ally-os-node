// #110 slice 3's web half, checked as source text — the same jsdom-free shape
// the audit-log/2FA/feedback tests use. What matters: the timeline reads the
// real endpoint, the four states never lie, a fresh comment also refreshes the
// timeline (both readers of the subject), and comment rows deep-link through
// the same ?comment= highlight the bell notifications land on.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const client = readFileSync(join(SRC, "shared", "lib", "activity-client.ts"), "utf8");
const page = readFileSync(join(SRC, "shared", "pages", "TaskDetail.tsx"), "utf8");

describe("activity client (#110 slice 3)", () => {
  it("reads the one endpoint with paging parameters, parsed by zod", () => {
    expect(client).toContain("`/api/activity?${params.toString()}`");
    expect(client).toContain("activityListSchema.parse");
  });

  it("reports the failure mode instead of flattening it", () => {
    expect(client).toContain('reason: "notfound"');
    expect(client).toContain('reason: "unavailable"');
  });
});

describe("task detail activity section (#110 slice 3)", () => {
  it("every state is said: loading, unavailable, empty, and the timeline", () => {
    expect(page).toContain('data-testid="activity-loading"');
    expect(page).toContain('data-testid="activity-unavailable"');
    expect(page).toContain('data-testid="activity-empty"');
    expect(page).toContain('data-testid="activity-list"');
  });

  it("comment rows deep-link through the ?comment= highlight the bell lands on", () => {
    expect(page).toContain("`/tasks/${props.subjectId}?comment=${row.target}`");
  });

  it("unknown actions render verbatim — the wordlist is open, rendering never guesses", () => {
    expect(page).toContain("default:");
    expect(page).toContain("return row.action;");
  });

  it("posting or deleting a comment refreshes both readers of the subject", () => {
    expect(page).toContain('queryKey: ["activity", "task", props.taskId]');
    expect(page).toContain('queryKey: ["comments", "task", props.taskId]');
    expect(page).toContain('invalidateQueries({ queryKey: ["activity", "task", props.taskId] })');
  });
});
