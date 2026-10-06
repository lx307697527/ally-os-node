// The numbering adapters' contracts, against a fake fetch — same discipline
// as notification-preferences-client.test.ts: reads report the failure mode
// instead of flattening it, writes speak the kernel's specific rejections,
// every parse is zod, and the preview renderer matches the server's issued
// numbers shape for shape.
import { describe, expect, it, vi } from "vitest";

import {
  createNumberingAdapters,
  nextSequenceFor,
  previewNumber,
  type NumberingRuleRow,
} from "./numbering-client.ts";

function fetchJson(body: unknown, status = 200): typeof fetch {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

const RULE: NumberingRuleRow = {
  id: "r1",
  subject: "invoice",
  label: "Sales invoice",
  prefix: "INV-",
  dateFormat: "YYYYMM",
  padding: 4,
  startNumber: 1000,
  active: true,
  lastIssued: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

describe("numbering adapters (#225)", () => {
  it("list: parses the rules page; 403 reads as forbidden, other failures as unavailable", async () => {
    const ok = createNumberingAdapters(fetchJson({ rules: [RULE] }));
    expect(await ok.list()).toEqual({ ok: true, data: [RULE] });

    const forbidden = createNumberingAdapters(fetchJson({}, 403));
    expect(await forbidden.list()).toEqual({ ok: false, reason: "forbidden" });

    const notOk = createNumberingAdapters(fetchJson({}, 500));
    expect(await notOk.list()).toEqual({ ok: false, reason: "unavailable" });

    // SPA fallback HTML behind a misrouted proxy: unavailable, not a crash
    const badShape = createNumberingAdapters(fetchJson({ rules: "all of them" }));
    expect(await badShape.list()).toEqual({ ok: false, reason: "unavailable" });

    const offline = createNumberingAdapters(() => Promise.reject(new Error("offline")));
    expect(await offline.list()).toEqual({ ok: false, reason: "unavailable" });
  });

  it("subjects: parses the registry list behind the same 403 gate", async () => {
    const ok = createNumberingAdapters(
      fetchJson({ subjects: [{ subject: "invoice", label: "Invoice" }] }),
    );
    expect(await ok.subjects()).toEqual({
      ok: true,
      data: [{ subject: "invoice", label: "Invoice" }],
    });
    const forbidden = createNumberingAdapters(fetchJson({}, 403));
    expect(await forbidden.subjects()).toEqual({ ok: false, reason: "forbidden" });
  });

  it("create: POSTs the full rule body and maps the kernel's rejections", async () => {
    const fetchFn = fetchJson({ id: "new-1" }, 201);
    const adapters = createNumberingAdapters(fetchFn);
    const input = {
      subject: "invoice",
      label: "Sales invoice",
      prefix: "INV-",
      dateFormat: null,
      padding: 4,
      startNumber: 1,
    };
    expect(await adapters.create(input)).toEqual({ ok: true, data: { id: "new-1" } });
    expect(fetchFn).toHaveBeenCalledWith("/api/numbering-rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });

    expect(
      await createNumberingAdapters(fetchJson({ error: "unregistered_subject" }, 400)).create(input),
    ).toEqual({ ok: false, reason: "unregistered" });
    expect(
      await createNumberingAdapters(fetchJson({ error: "rule_exists" }, 409)).create(input),
    ).toEqual({ ok: false, reason: "exists" });
    expect(
      await createNumberingAdapters(fetchJson({ error: "invalid_request" }, 400)).create(input),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(await createNumberingAdapters(fetchJson({}, 403)).create(input)).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(await createNumberingAdapters(fetchJson({}, 500)).create(input)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("update: PATCHes to the encoded id; 404 is not_found, 409 is exists, success returns the row", async () => {
    const fetchFn = fetchJson({ ...RULE, label: "Renamed" });
    const adapters = createNumberingAdapters(fetchFn);
    const result = await adapters.update("r1", { label: "Renamed", active: false });
    expect(result).toEqual({ ok: true, data: { ...RULE, label: "Renamed" } });
    expect(fetchFn).toHaveBeenCalledWith("/api/numbering-rules/r1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Renamed", active: false }),
    });

    expect(await createNumberingAdapters(fetchJson({}, 404)).update("r1", {})).toEqual({
      ok: false,
      reason: "not_found",
    });
    // 重新激活撞上同对象的另一条生效规则:409,页面据此说「先停用那条」
    expect(await createNumberingAdapters(fetchJson({ error: "rule_exists" }, 409)).update("r1", { active: true })).toEqual(
      { ok: false, reason: "exists" },
    );
    // startNumber 不在 update 输入的形状里:客户端根本没有这条可走的路
    const never = await createNumberingAdapters(fetchJson({ error: "invalid_request" }, 400)).update(
      "r1",
      { padding: 99 },
    );
    expect(never).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("number preview (#225: same shape the server mints)", () => {
  const CLOCK = new Date(Date.UTC(2026, 9, 6, 12)); // 2026-10-06 12:00 UTC

  it("next sequence: past the highest issued, or the series start when nothing issued", () => {
    expect(nextSequenceFor({ lastIssued: null, startNumber: 1000 })).toBe(1000);
    expect(nextSequenceFor({ lastIssued: 1000, startNumber: 1 })).toBe(1001);
  });

  it("renders prefix + date segment + zero-padded sequence, exactly like formatDocumentNumber", () => {
    expect(previewNumber({ prefix: "INV-", dateFormat: "YYYYMM", padding: 4 }, 1000, CLOCK)).toBe(
      "INV-202610-1000",
    );
    expect(previewNumber({ prefix: "INV-", dateFormat: null, padding: 4 }, 1, CLOCK)).toBe("INV-0001");
    expect(previewNumber({ prefix: "QT-", dateFormat: "YYYY", padding: 6 }, 2, CLOCK)).toBe("QT-2026-000002");
    expect(previewNumber({ prefix: "PO-", dateFormat: "YYYYMMDD", padding: 2 }, 12345, CLOCK)).toBe(
      "PO-20261006-12345",
    );
  });
});
