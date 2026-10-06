import { describe, expect, it } from "vitest";

import { createCommentAdapters } from "./comments-client.ts";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const COMMENT_ROW = {
  id: "c-1",
  subjectType: "task",
  subjectId: "t-1",
  body: "@Alice can you check the claim?",
  author: { id: "u-2", name: "Bob" },
  createdAt: "2026-10-06T08:00:00.000Z",
};

describe("comments client (#110 slice 1)", () => {
  it("list carries subjectType/subjectId/limit/offset as query parameters", async () => {
    const calls: string[] = [];
    const adapters = createCommentAdapters((input) => {
      if (typeof input === "string") calls.push(input);
      return Promise.resolve(jsonRes({ comments: [COMMENT_ROW], total: 1 }));
    });
    const page = await adapters.list({ subjectType: "task", subjectId: "t-1", limit: 50, offset: 0 });
    expect(calls).toEqual(["/api/comments?subjectType=task&subjectId=t-1&limit=50&offset=0"]);
    expect(page).toEqual({ ok: true, data: { comments: [COMMENT_ROW], total: 1 } });
  });

  it("list: 404 is notfound (subject gone or not yours), other failures unavailable", async () => {
    const gone = createCommentAdapters(() => Promise.resolve(new Response("nope", { status: 404 })));
    await expect(
      gone.list({ subjectType: "task", subjectId: "t-1", limit: 50, offset: 0 }),
    ).resolves.toEqual({ ok: false, reason: "notfound" });

    const dead = createCommentAdapters(() => Promise.reject(new Error("down")));
    await expect(
      dead.list({ subjectType: "task", subjectId: "t-1", limit: 50, offset: 0 }),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });

    const html = createCommentAdapters(() =>
      Promise.resolve(new Response("<html>fallback</html>", { status: 200 })),
    );
    await expect(
      html.list({ subjectType: "task", subjectId: "t-1", limit: 50, offset: 0 }),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("create posts the JSON body and returns the comment with who was notified", async () => {
    const seen: { url: string; body: string }[] = [];
    const adapters = createCommentAdapters((input, init) => {
      if (typeof input === "string" && typeof init?.body === "string") {
        seen.push({ url: input, body: init.body });
      }
      return Promise.resolve(
        jsonRes({ comment: COMMENT_ROW, mentioned: [{ id: "u-1", name: "Alice" }], notifiedFollowers: 0 }, 201),
      );
    });
    const made = await adapters.create({ subjectType: "task", subjectId: "t-1", body: "hi @Alice" });
    expect(seen[0]?.url).toBe("/api/comments");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ subjectType: "task", subjectId: "t-1", body: "hi @Alice" });
    expect(made).toEqual({
      ok: true,
      data: { comment: COMMENT_ROW, mentioned: [{ id: "u-1", name: "Alice" }], notifiedFollowers: 0 },
    });
  });

  it("create parses the follower fan-out count (#110 slice 4)", async () => {
    const adapters = createCommentAdapters(() =>
      Promise.resolve(
        jsonRes({ comment: COMMENT_ROW, mentioned: [], notifiedFollowers: 2 }, 201),
      ),
    );
    const made = await adapters.create({ subjectType: "task", subjectId: "t-1", body: "note" });
    expect(made).toEqual({ ok: true, data: { comment: COMMENT_ROW, mentioned: [], notifiedFollowers: 2 } });
  });

  it("create: 400 conflict、404 notfound、垃圾体 unavailable", async () => {
    const rejected = createCommentAdapters(() => Promise.resolve(jsonRes({ error: "x" }, 400)));
    await expect(rejected.create({ subjectType: "task", subjectId: "t-1", body: "x" })).resolves.toEqual({
      ok: false,
      reason: "conflict",
    });
    const gone = createCommentAdapters(() => Promise.resolve(jsonRes({ error: "x" }, 404)));
    await expect(gone.create({ subjectType: "task", subjectId: "t-1", body: "x" })).resolves.toEqual({
      ok: false,
      reason: "notfound",
    });
    const html = createCommentAdapters(() =>
      Promise.resolve(new Response("<html>fallback</html>", { status: 200 })),
    );
    await expect(html.create({ subjectType: "task", subjectId: "t-1", body: "x" })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("remove: 403 forbidden（别人的评论）、404 notfound、成功 ok", async () => {
    const ok = createCommentAdapters(() => Promise.resolve(jsonRes({ deleted: true })));
    await expect(ok.remove("c-1")).resolves.toEqual({ ok: true });

    const forbidden = createCommentAdapters(() => Promise.resolve(jsonRes({ error: "x" }, 403)));
    await expect(forbidden.remove("c-1")).resolves.toEqual({ ok: false, reason: "forbidden" });

    const gone = createCommentAdapters(() => Promise.resolve(jsonRes({ error: "x" }, 404)));
    await expect(gone.remove("c-1")).resolves.toEqual({ ok: false, reason: "notfound" });

    const dead = createCommentAdapters(() => Promise.reject(new Error("down")));
    await expect(dead.remove("c-1")).resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});
