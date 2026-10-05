// #113 slice 1's web half, checked as source text — the same jsdom-free shape
// the audit-log tests use. What matters: the page reads the real endpoints,
// states never lie (unavailable is said, not blanked), the checkbox is the
// open/done toggle and never a cancelled state, and the shell/route wiring
// uses the same table the rail prints.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const client = readFileSync(join(SRC, "shared", "lib", "tasks-client.ts"), "utf8");
const page = readFileSync(join(SRC, "shared", "pages", "Tasks.tsx"), "utf8");
const app = readFileSync(join(SRC, "App.tsx"), "utf8");
const rail = readFileSync(join(SRC, "shared", "shell", "rail-groups.ts"), "utf8");
const icons = readFileSync(join(SRC, "shared", "shell", "RailIcon.tsx"), "utf8");

describe("tasks client (#113)", () => {
  it("reads and writes the real endpoints, bodies parsed by zod", () => {
    expect(client).toContain("`/api/tasks?${params.toString()}`");
    expect(client).toContain('fetchFn("/api/tasks/assignee-options")');
    expect(client).toContain('method: "POST"');
    expect(client).toContain('method: "PATCH"');
    expect(client).toContain("taskListSchema.parse");
    expect(client).toContain("taskRowSchema.nullable()");
    expect(client).toContain(".safeParse(gate.data)");
  });

  it("reports the failure mode instead of flattening it", () => {
    expect(client).toContain('reason: "forbidden"');
    expect(client).toContain('reason: "conflict"');
    expect(client).toContain('reason: "unavailable"');
  });
});

describe("tasks page (#113)", () => {
  it("every state is said: loading, unavailable, empty, action error, list", () => {
    expect(page).toContain('data-testid="tasks-loading"');
    expect(page).toContain('data-testid="tasks-unavailable"');
    expect(page).toContain('data-testid="tasks-empty"');
    expect(page).toContain('data-testid="tasks-action-error"');
    expect(page).toContain('data-testid="tasks-list"');
  });

  it("the checkbox is the open/done toggle; cancelled rows cannot be ticked", () => {
    expect(page).toContain('row.status === "done" ? "open" : "done"');
    expect(page).toContain('disabled={row.status === "cancelled"}');
    expect(page).toContain("checked={row.status === \"done\"}");
  });

  it("scopes and status filters re-page from zero; the pager is bounded", () => {
    expect(page).toContain("data-testid={`tasks-scope-${tab.value}`}");
    expect(page).toContain("data-testid={`tasks-status-${chip.value}`}");
    expect(page).toContain("offset + PAGE_SIZE < data.total");
    expect(page).toContain("setOffset(0)");
    expect(page).toContain("of ${String(data.total)}");
  });

  it("creating a task can assign an assignee — the notification promise is said", () => {
    expect(page).toContain('data-testid="tasks-create-assignee"');
    expect(page).toContain("Assignment notifies the assignee in the bell");
  });

  it("overdue is computed from facts, never invented", () => {
    expect(page).toContain('row.dueAt !== null && row.status === "open"');
  });

  it("the title is the way into the detail page (#110 slice 1) — cancelled keeps the strike", () => {
    expect(page).toContain('to={`/tasks/${row.id}`}');
    expect(page).toContain('data-testid="tasks-row-title"');
    expect(page).toContain('text-ui text-ink-soft line-through hover:text-link');
  });
});

describe("wiring (#113)", () => {
  it("the route exists and the rail item points at it — one table, no drift", () => {
    expect(app).toContain('path="/tasks"');
    expect(app).toContain("<Tasks />");
    expect(rail).toContain('to: "/tasks"');
  });

  it("the home group is no longer the Dashboard alone — the note tells the truth", () => {
    expect(rail).toContain("their own to-dos");
  });

  it("the rail row names its glyph in the set — no unnamed mark", () => {
    expect(rail).toContain('icon: "tasks"');
    expect(icons).toContain('"tasks"');
  });
});
