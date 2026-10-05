import { describe, expect, it } from "vitest";

import { createNotificationAdapters } from "./notifications-client.ts";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("notifications client (#129 slice 4)", () => {
  it("summary:合法体透传", async () => {
    const calls: string[] = [];
    const adapters = createNotificationAdapters((input) => {
      if (typeof input === "string") calls.push(input);
      return Promise.resolve(
        jsonRes({
          recent: [
            {
              id: "n-1",
              eventType: "quote.viewed",
              aggregateType: "quote",
              aggregateId: "q-1",
              payload: { title: "Quote viewed" },
              isRead: false,
              createdAt: "2026-10-06T08:00:00.000Z",
            },
          ],
          unreadCount: 21,
        }),
      );
    });
    const summary = await adapters.summary();
    expect(calls).toEqual(["/api/notifications/summary"]);
    expect(summary?.recent).toHaveLength(1);
    expect(summary?.unreadCount).toBe(21);
  });

  it("summary:HTTP 错误 / 垃圾体（SPA fallback）/ 网络失败 → null,不抛", async () => {
    const bad = createNotificationAdapters(() => Promise.resolve(new Response("nope", { status: 500 })));
    await expect(bad.summary()).resolves.toBeNull();

    const html = createNotificationAdapters(() =>
      Promise.resolve(new Response("<html>fallback</html>", { status: 200 })),
    );
    await expect(html.summary()).resolves.toBeNull();

    const dead = createNotificationAdapters(() => Promise.reject(new Error("down")));
    await expect(dead.summary()).resolves.toBeNull();
  });

  it("summary:形状不对（缺字段/类型错）→ null", async () => {
    const wrong = createNotificationAdapters(() =>
      Promise.resolve(jsonRes({ recent: "all", unreadCount: "many" })),
    );
    await expect(wrong.summary()).resolves.toBeNull();
  });

  it("markRead 走 POST 且 id 经 encodeURIComponent", async () => {
    const calls: { url: string; method: string }[] = [];
    const adapters = createNotificationAdapters((input, init) => {
      calls.push({ url: typeof input === "string" ? input : "", method: init?.method ?? "GET" });
      return Promise.resolve(jsonRes({ marked: 1 }));
    });
    await expect(adapters.markRead("a/b?id=1")).resolves.toBe(true);
    expect(calls).toEqual([
      { url: "/api/notifications/a%2Fb%3Fid%3D1/read", method: "POST" },
    ]);
  });

  it("markRead/markAllRead 失败降级（false/null），不抛", async () => {
    const dead = createNotificationAdapters(() => Promise.reject(new Error("down")));
    await expect(dead.markRead("n-1")).resolves.toBe(false);
    await expect(dead.markAllRead()).resolves.toBeNull();

    const refused = createNotificationAdapters(() => Promise.resolve(jsonRes({ marked: 0 }, 403)));
    await expect(refused.markAllRead()).resolves.toBeNull();
  });

  it("markAllRead 校验体并返回真实条数", async () => {
    const adapters = createNotificationAdapters(() => Promise.resolve(jsonRes({ marked: 7 })));
    await expect(adapters.markAllRead()).resolves.toBe(7);
  });
});
