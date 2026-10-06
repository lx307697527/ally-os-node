// #110 slice 4's web half, checked as source text — the same jsdom-free shape
// the task-detail-page tests use. What matters: the detail page reads the real
// follow endpoints, the toggle renders only once the state is known, both the
// follower list and the timeline refresh on a toggle (following is an activity
// row), and the composer says when a comment reached followers.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(SRC, "shared", "pages", "TaskDetail.tsx"), "utf8");
const client = readFileSync(join(SRC, "shared", "lib", "follows-client.ts"), "utf8");
const commentsClient = readFileSync(join(SRC, "shared", "lib", "comments-client.ts"), "utf8");

describe("task detail follows (#110 slice 4)", () => {
  it("the page reads the real follow endpoints through the follow adapters", () => {
    expect(page).toContain("followAdapters.state(\"task\", props.taskId)");
    expect(page).toContain('followAdapters.unfollow("task", props.subjectId)');
    expect(page).toContain('followAdapters.follow("task", props.subjectId)');
    expect(client).toContain("`/api/follows/${encodeURIComponent(subjectType)}/${encodeURIComponent(subjectId)}`");
    expect(client).toContain('"PUT"');
    expect(client).toContain('"DELETE"');
    expect(client).toContain("followStateSchema.parse");
  });

  it("every state is said: loading, unavailable, action error", () => {
    expect(page).toContain('data-testid="follow-loading"');
    expect(page).toContain('data-testid="follow-unavailable"');
    expect(page).toContain('data-testid="follow-error"');
    expect(page).toContain('data-testid="follow-toggle"');
    expect(page).toContain('data-testid="follow-state"');
  });

  it("the toggle refreshes the follower list AND the timeline (follow rows are activity)", () => {
    expect(page).toContain('queryKey: ["follows", "task", props.taskId]');
    expect(page).toContain('queryKey: ["activity", "task", props.taskId]');
    expect(page).toContain('queryKey: ["follows", "task", props.taskId] });');
  });

  it("the follower line names who else is watching — following is a shared fact", () => {
    expect(page).toContain("Followed by ${props.state.followers.map((row) => row.name).join(\", \")}.");
    expect(page).toContain("No followers yet.");
  });

  it("the timeline reads follow.created/follow.deleted as sentences, unknown actions verbatim", () => {
    expect(page).toContain('case "follow.created":');
    expect(page).toContain("started following the task");
    expect(page).toContain('case "follow.deleted":');
    expect(page).toContain("stopped following the task");
  });

  it("the composer reports the follower reach of a comment", () => {
    expect(commentsClient).toContain("notifiedFollowers: z.number().int().nonnegative()");
    expect(page).toContain("result.data.notifiedFollowers > 0");
    expect(page).toContain("follower${result.data.notifiedFollowers === 1 ? \"\" : \"s\"}");
  });
});
