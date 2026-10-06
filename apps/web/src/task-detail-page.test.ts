// #110 slice 1's web half, checked as source text — the same jsdom-free shape
// the tasks-page tests use. What matters: the detail page reads the real
// endpoints, every state is said (loading / unavailable / not-yours / empty),
// the ?comment= deep link walks to the mentioned row, the composer names the
// participants it can mention, and the route + back link keep the record
// route attached to its list.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(SRC, "shared", "pages", "TaskDetail.tsx"), "utf8");
const client = readFileSync(join(SRC, "shared", "lib", "comments-client.ts"), "utf8");
const tasksClient = readFileSync(join(SRC, "shared", "lib", "tasks-client.ts"), "utf8");
const app = readFileSync(join(SRC, "App.tsx"), "utf8");
const list = readFileSync(join(SRC, "shared", "pages", "Tasks.tsx"), "utf8");

describe("task detail page (#110 slice 1)", () => {
  it("reads the real endpoints: task by id, comments by subject", () => {
    expect(page).toContain("taskAdapters.get(props.taskId)");
    expect(page).toContain('subjectType: "task"');
    expect(page).toContain("commentAdapters.list(");
    expect(tasksClient).toContain("async get(id: string): Promise<TaskGetResult>");
    expect(tasksClient).toContain('reason: "notfound" | "unavailable"');
    expect(client).toContain("`/api/comments?${params.toString()}`");
    expect(client).toContain('method: "POST"');
    expect(client).toContain('method: "DELETE"');
    expect(client).toContain("commentListSchema.parse");
  });

  it("every state is said: loading, unavailable, not-yours, empty, action error", () => {
    expect(page).toContain('data-testid="task-detail-loading"');
    expect(page).toContain('data-testid="task-detail-unavailable"');
    expect(page).toContain('data-testid="task-detail-notfound"');
    expect(page).toContain('data-testid="comments-loading"');
    expect(page).toContain('data-testid="comments-unavailable"');
    expect(page).toContain('data-testid="comments-empty"');
    expect(page).toContain('data-testid="comments-compose-error"');
  });

  it("the ?comment= deep link walks to the row and holds the highlight", () => {
    expect(page).toContain('searchParams.get("comment")');
    expect(page).toContain('data-comment-id={row.id}');
    expect(page).toContain("scrollIntoView({ block: \"center\" })");
    expect(page).toContain("ring-accent");
  });

  it("the composer names the participants — a mention that names an outsider is never a surprise", () => {
    expect(page).toContain("Participants: ${props.viewers.map((p) => p.name).join(\", \")}");
    expect(page).toContain("@Full Name");
    expect(page).toContain('data-testid="comments-notified"');
  });

  it("only the author's rows offer Delete; delete failures are said", () => {
    expect(page).toContain("row.author?.id === props.meId");
    expect(page).toContain('data-testid="comment-delete"');
    expect(page).toContain("Only the author can delete a comment.");
  });

  it("the author's rows offer inline Edit; the edited marker and its failures are said (#110 slice 5)", () => {
    expect(page).toContain('data-testid="comment-edit"');
    expect(page).toContain('data-testid="comment-edit-save"');
    expect(page).toContain('data-testid="comment-edit-cancel"');
    expect(page).toContain('data-testid="comment-edit-error"');
    // the "(edited)" marker reads the row's editedAt, null = never edited
    expect(page).toContain('row.editedAt !== null ? " · (edited)" : ""');
    expect(page).toContain("Only the author can edit a comment.");
    expect(client).toContain('method: "PATCH"');
    expect(client).toContain("editedAt: z.string().nullable()");
  });

  it("the record route keeps its list one link away", () => {
    expect(page).toContain('to="/tasks"');
    expect(app).toContain('path="/tasks/:taskId"');
    expect(app).toContain("<TaskDetail />");
    expect(list).toContain('to={`/tasks/${row.id}`}');
  });
});
