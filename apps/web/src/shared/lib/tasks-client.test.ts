import { describe, expect, it } from "vitest";

import { createTaskAdapters } from "./tasks-client.ts";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TASK_ROW = {
  id: "t-1",
  title: "Follow up the sample",
  description: null,
  status: "open",
  dueAt: "2026-10-10T00:00:00.000Z",
  assignee: { id: "u-2", name: "Bob" },
  createdBy: { id: "u-1", name: "Alice" },
  createdAt: "2026-10-06T08:00:00.000Z",
  updatedAt: "2026-10-06T08:00:00.000Z",
};

describe("tasks client (#113 slice 1)", () => {
  it("list carries scope/status/limit/offset as query parameters", async () => {
    const calls: string[] = [];
    const adapters = createTaskAdapters((input) => {
      if (typeof input === "string") calls.push(input);
      return Promise.resolve(jsonRes({ tasks: [TASK_ROW], total: 1 }));
    });
    const page = await adapters.list({ scope: "assigned", status: "open", limit: 50, offset: 50 });
    expect(calls).toEqual(["/api/tasks?scope=assigned&status=open&limit=50&offset=50"]);
    expect(page).toEqual({ ok: true, data: { tasks: [TASK_ROW], total: 1 } });

    await adapters.list({ scope: "created", limit: 50, offset: 0 });
    expect(calls[1]).toBe("/api/tasks?scope=created&limit=50&offset=0");
  });

  it("list: HTTP 错误 / 垃圾体 / 网络失败 → unavailable，不抛", async () => {
    const bad = createTaskAdapters(() => Promise.resolve(new Response("nope", { status: 500 })));
    const badPage = await bad.list({ scope: "assigned", limit: 50, offset: 0 });
    expect(badPage).toEqual({ ok: false, reason: "unavailable" });

    const html = createTaskAdapters(() =>
      Promise.resolve(new Response("<html>fallback</html>", { status: 200 })),
    );
    await expect(html.list({ scope: "assigned", limit: 50, offset: 0 })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });

    const dead = createTaskAdapters(() => Promise.reject(new Error("down")));
    await expect(dead.list({ scope: "assigned", limit: 50, offset: 0 })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("assigneeOptions parses the directory; failures read as unavailable", async () => {
    const adapters = createTaskAdapters(() =>
      Promise.resolve(
        jsonRes({ assignees: [{ id: "u-1", name: "Alice", email: "a@example.com" }] }),
      ),
    );
    const options = await adapters.assigneeOptions();
    expect(options).toEqual({
      ok: true,
      data: [{ id: "u-1", name: "Alice", email: "a@example.com" }],
    });

    const dead = createTaskAdapters(() => Promise.reject(new Error("down")));
    await expect(dead.assigneeOptions()).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("create: 201 带行、400 conflict、403 forbidden、垃圾体 unavailable", async () => {
    const ok = createTaskAdapters(() => Promise.resolve(jsonRes({ task: TASK_ROW }, 201)));
    const created = await ok.create({ title: "x", assigneeId: "u-2" });
    expect(created).toEqual({ ok: true, data: TASK_ROW });

    const rejected = createTaskAdapters(() => Promise.resolve(jsonRes({ error: "x" }, 400)));
    await expect(rejected.create({ title: "x" })).resolves.toEqual({
      ok: false,
      reason: "conflict",
    });

    const forbidden = createTaskAdapters(() => Promise.resolve(jsonRes({ error: "x" }, 403)));
    await expect(forbidden.create({ title: "x" })).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });

    const html = createTaskAdapters(() =>
      Promise.resolve(new Response("<html>fallback</html>", { status: 200 })),
    );
    await expect(html.create({ title: "x" })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("patch sends the JSON body to the task's own URL; 403 is forbidden", async () => {
    const seen: { url: string; body: string }[] = [];
    const adapters = createTaskAdapters((input, init) => {
      if (typeof input === "string" && typeof init?.body === "string") {
        seen.push({ url: input, body: init.body });
      }
      return Promise.resolve(jsonRes({ task: { ...TASK_ROW, status: "done" } }));
    });
    const patched = await adapters.patch("t-1", { status: "done" });
    expect(seen[0]?.url).toBe("/api/tasks/t-1");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ status: "done" });
    expect(patched).toEqual({ ok: true, data: { ...TASK_ROW, status: "done" } });

    const forbidden = createTaskAdapters(() => Promise.resolve(jsonRes({ error: "x" }, 403)));
    await expect(forbidden.patch("t-1", { assigneeId: null })).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });
  });
});
