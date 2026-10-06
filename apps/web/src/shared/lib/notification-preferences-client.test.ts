// The preferences adapter's contracts, against a fake fetch — same discipline
// as notifications-client.test.ts: every failure mode degrades to null, the
// parses are zod, and the PUT carries the full-replacement body.
import { describe, expect, it, vi } from "vitest";

import { createNotificationPreferencesAdapters } from "./notification-preferences-client.ts";

/** A Promise-returning (hence fetch-shaped) responder; non-2xx = failure face */
function fetchJson(body: unknown, ok = true): typeof fetch {
  return vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status: ok ? 200 : 500 })),
  );
}

describe("notification preferences client (#116)", () => {
  it("load: 解析服务端形状（updatedAt 可为 null 的默认态）", async () => {
    const fetchFn = fetchJson({ emailDigest: false, updatedAt: null });
    const adapters = createNotificationPreferencesAdapters(fetchFn);
    expect(await adapters.load()).toEqual({ emailDigest: false, updatedAt: null });
    expect(fetchFn).toHaveBeenCalledWith("/api/notifications/preferences");
  });

  it("load: 非 OK / 坏形状 / 网络炸一律 null，不抛", async () => {
    const notOk = createNotificationPreferencesAdapters(
      fetchJson({ emailDigest: true, updatedAt: null }, false),
    );
    expect(await notOk.load()).toBeNull();

    const badShape = createNotificationPreferencesAdapters(
      fetchJson({ emailDigest: "yes", updatedAt: null }),
    );
    expect(await badShape.load()).toBeNull();

    const boom = createNotificationPreferencesAdapters(() => Promise.reject(new Error("offline")));
    expect(await boom.load()).toBeNull();
  });

  it("save: PUT 带整份替换体；成功回读，失败 null", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ emailDigest: true, updatedAt: "2026-10-07T02:00:00.000Z" }), {
          status: 200,
        }),
      ),
    );
    const adapters = createNotificationPreferencesAdapters(fetchFn);
    expect(await adapters.save({ emailDigest: true })).toEqual({
      emailDigest: true,
      updatedAt: "2026-10-07T02:00:00.000Z",
    });
    expect(fetchFn).toHaveBeenCalledWith("/api/notifications/preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emailDigest: true }),
    });

    const failing = createNotificationPreferencesAdapters(
      fetchJson({ emailDigest: true, updatedAt: null }, false),
    );
    expect(await failing.save({ emailDigest: true })).toBeNull();
  });
});
