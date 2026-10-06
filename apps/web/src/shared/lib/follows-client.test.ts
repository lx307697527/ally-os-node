import { describe, expect, it } from "vitest";

import { createFollowAdapters } from "./follows-client.ts";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const FOLLOW_STATE = {
  followers: [
    { id: "u-1", name: "Alice", createdAt: "2026-10-06T08:00:00.000Z" },
    { id: "u-2", name: "Bob", createdAt: "2026-10-06T08:05:00.000Z" },
  ],
  total: 2,
  meFollowing: true,
};

describe("follows client (#110 slice 4)", () => {
  it("state hits /api/follows/:subjectType/:subjectId and parses the follower list", async () => {
    const calls: string[] = [];
    const adapters = createFollowAdapters((input) => {
      if (typeof input === "string") calls.push(input);
      return Promise.resolve(jsonRes(FOLLOW_STATE));
    });
    const state = await adapters.state("task", "t-1");
    expect(calls).toEqual(["/api/follows/task/t-1"]);
    expect(state).toEqual({ ok: true, data: FOLLOW_STATE });
  });

  it("follow and unfollow use PUT / DELETE on the same resource", async () => {
    const methods: string[] = [];
    const adapters = createFollowAdapters((input, init) => {
      if (typeof input === "string") methods.push(`${init?.method ?? "GET"} ${input}`);
      return Promise.resolve(jsonRes({ meFollowing: init?.method === "PUT" }));
    });
    const on = await adapters.follow("task", "t-1");
    const off = await adapters.unfollow("task", "t-1");
    expect(methods).toEqual(["PUT /api/follows/task/t-1", "DELETE /api/follows/task/t-1"]);
    expect(on).toEqual({ ok: true, data: { meFollowing: true } });
    expect(off).toEqual({ ok: true, data: { meFollowing: false } });
  });

  it("400 conflict、404 notfound、垃圾体 unavailable", async () => {
    const bad = createFollowAdapters(() => Promise.resolve(jsonRes({ error: "x" }, 400)));
    await expect(bad.state("glyph", "t-1")).resolves.toEqual({ ok: false, reason: "conflict" });
    const gone = createFollowAdapters(() => Promise.resolve(jsonRes({ error: "x" }, 404)));
    await expect(gone.follow("task", "t-1")).resolves.toEqual({ ok: false, reason: "notfound" });
    await expect(gone.unfollow("task", "t-1")).resolves.toEqual({ ok: false, reason: "notfound" });
    const html = createFollowAdapters(() =>
      Promise.resolve(new Response("<html>fallback</html>", { status: 200 })),
    );
    await expect(html.state("task", "t-1")).resolves.toEqual({ ok: false, reason: "unavailable" });
    const dead = createFollowAdapters(() => Promise.reject(new Error("down")));
    await expect(dead.follow("task", "t-1")).resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});
