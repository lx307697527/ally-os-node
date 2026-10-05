import { describe, expect, it } from "vitest";

import { createActivityAdapters } from "./activity-client.ts";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const EVENT_ROW = {
  id: "a-1",
  action: "task.status_changed",
  target: "t-1",
  detail: { from: "open", to: "done" },
  actor: { id: "u-1", name: "Alice" },
  createdAt: "2026-10-06T08:00:00.000Z",
};

describe("activity client (#110 slice 3)", () => {
  it("list carries subjectType/subjectId/limit/offset as query parameters", async () => {
    const calls: string[] = [];
    const adapters = createActivityAdapters((input) => {
      if (typeof input === "string") calls.push(input);
      return Promise.resolve(jsonRes({ events: [EVENT_ROW], total: 1 }));
    });
    const page = await adapters.list({ subjectType: "task", subjectId: "t-1", limit: 50, offset: 0 });
    expect(calls).toEqual(["/api/activity?subjectType=task&subjectId=t-1&limit=50&offset=0"]);
    expect(page).toEqual({ ok: true, data: { events: [EVENT_ROW], total: 1 } });
  });

  it("rows without an actor (system rows) and null detail parse as-is", async () => {
    const adapters = createActivityAdapters(() =>
      Promise.resolve(
        jsonRes({
          events: [
            {
              id: "a-2",
              action: "task.created",
              target: "t-1",
              detail: null,
              actor: null,
              createdAt: "2026-10-06T07:00:00.000Z",
            },
          ],
          total: 1,
        }),
      ),
    );
    const page = await adapters.list({ subjectType: "task", subjectId: "t-1", limit: 50, offset: 0 });
    expect(page).toEqual({
      ok: true,
      data: {
        events: [
          {
            id: "a-2",
            action: "task.created",
            target: "t-1",
            detail: null,
            actor: null,
            createdAt: "2026-10-06T07:00:00.000Z",
          },
        ],
        total: 1,
      },
    });
  });

  it("list: 404 is notfound (subject gone or not yours), other failures unavailable", async () => {
    const gone = createActivityAdapters(() => Promise.resolve(new Response("nope", { status: 404 })));
    await expect(
      gone.list({ subjectType: "task", subjectId: "t-1", limit: 50, offset: 0 }),
    ).resolves.toEqual({ ok: false, reason: "notfound" });

    const dead = createActivityAdapters(() => Promise.reject(new Error("down")));
    await expect(
      dead.list({ subjectType: "task", subjectId: "t-1", limit: 50, offset: 0 }),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });

    const html = createActivityAdapters(() =>
      Promise.resolve(new Response("<html>fallback</html>", { status: 200 })),
    );
    await expect(
      html.list({ subjectType: "task", subjectId: "t-1", limit: 50, offset: 0 }),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});
