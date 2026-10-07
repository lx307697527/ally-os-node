import { describe, expect, it } from "vitest";

import { createDeletedRecordsAdapters } from "./deleted-records-client.ts";

/** fetch 的入参三种形态各取各的 URL（Request 对象不能走 String()） */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const LEDGER_ROW = {
  id: "dr-1",
  subjectType: "task",
  subjectId: "t-1",
  title: "Follow up the sample",
  snapshot: { id: "t-1", title: "Follow up the sample", status: "open" },
  deletedBy: { id: "u-1", name: "Alice" },
  deletedAt: "2026-10-07T09:00:00.000Z",
  restoredBy: null,
  restoredAt: null,
};

describe("deleted records client (#29 slice 2)", () => {
  it("page carries limit/offset as query parameters, parsed by zod", async () => {
    const calls: string[] = [];
    const adapters = createDeletedRecordsAdapters((input) => {
      calls.push(requestUrl(input));
      return Promise.resolve(jsonRes({ records: [LEDGER_ROW], total: 1 }));
    });
    const page = await adapters.page({ limit: 50, offset: 50 });
    expect(calls).toEqual(["/api/deleted-records?limit=50&offset=50"]);
    expect(page).toEqual({ ok: true, data: { records: [LEDGER_ROW], total: 1 } });
  });

  it("page: 403 is forbidden (not a network error); garbage and network failures are unavailable", async () => {
    const gated = createDeletedRecordsAdapters(() => Promise.resolve(jsonRes({}, 403)));
    await expect(gated.page({ limit: 50, offset: 0 })).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });

    const html = createDeletedRecordsAdapters(() =>
      Promise.resolve(new Response("<html>fallback</html>", { status: 200 })),
    );
    await expect(html.page({ limit: 50, offset: 0 })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });

    const dead = createDeletedRecordsAdapters(() => Promise.reject(new Error("down")));
    await expect(dead.page({ limit: 50, offset: 0 })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("restore posts to the ledger row and returns the updated record", async () => {
    const calls: { url: string; init?: RequestInit | undefined }[] = [];
    const restored = {
      ...LEDGER_ROW,
      restoredBy: { id: "u-9", name: "Owner" },
      restoredAt: "2026-10-07T10:00:00.000Z",
    };
    const adapters = createDeletedRecordsAdapters((input, init) => {
      calls.push({ url: requestUrl(input), init });
      return Promise.resolve(jsonRes({ record: restored }));
    });
    const result = await adapters.restore("dr-1");
    expect(calls[0]?.url).toBe("/api/deleted-records/dr-1/restore");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(result).toEqual({ ok: true, data: restored });
  });

  it("restore keeps the server's conflict word: 409 bodies are parsed, not flattened", async () => {
    const conflict = createDeletedRecordsAdapters(() =>
      Promise.resolve(jsonRes({ error: "restore_unsupported" }, 409)),
    );
    await expect(conflict.restore("dr-1")).resolves.toEqual({
      ok: false,
      reason: "conflict",
      code: "restore_unsupported",
    });

    // 垃圾 409 体也如实到页面，只是没有词
    const garbage = createDeletedRecordsAdapters(() =>
      Promise.resolve(new Response("<html>", { status: 409 })),
    );
    await expect(garbage.restore("dr-1")).resolves.toEqual({
      ok: false,
      reason: "conflict",
    });
  });

  it("restore: 404 notfound, 403 forbidden, network unavailable", async () => {
    const gone = createDeletedRecordsAdapters(() => Promise.resolve(jsonRes({}, 404)));
    await expect(gone.restore("dr-1")).resolves.toEqual({ ok: false, reason: "notfound" });

    const gated = createDeletedRecordsAdapters(() => Promise.resolve(jsonRes({}, 403)));
    await expect(gated.restore("dr-1")).resolves.toEqual({ ok: false, reason: "forbidden" });

    const dead = createDeletedRecordsAdapters(() => Promise.reject(new Error("down")));
    await expect(dead.restore("dr-1")).resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});
