// The custom fields adapters' contracts, against a fake fetch — same
// discipline as numbering-client.test.ts: reads report the failure mode
// instead of flattening it, writes speak the kernel's specific rejections,
// every parse is zod, and the role mirror keeps the server enum honest
// (customer included — a field may be visible to the customer; approvers may
// not be).
import { describe, expect, it, vi } from "vitest";

import {
  createCustomFieldsAdapters,
  CUSTOM_FIELD_DEF_SUBJECT,
  FIELD_ROLES,
  FIELD_TYPES,
  type CustomFieldRow,
} from "./custom-fields-client.ts";

function fetchJson(body: unknown, status = 200): typeof fetch {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

const FIELD: CustomFieldRow = {
  id: "f1",
  subjectType: "task",
  fieldKey: "po_number",
  label: "PO number",
  fieldType: "text",
  options: null,
  required: false,
  viewableBy: [],
  editableBy: [],
  active: true,
  version: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
};

describe("custom fields adapters (#222)", () => {
  it("list: parses the fields page; 403 reads as forbidden, other failures as unavailable", async () => {
    const ok = createCustomFieldsAdapters(fetchJson({ fields: [FIELD] }));
    expect(await ok.list()).toEqual({ ok: true, data: [FIELD] });
    expect(await ok.list("task")).toEqual({ ok: true, data: [FIELD] });

    const forbidden = createCustomFieldsAdapters(fetchJson({}, 403));
    expect(await forbidden.list()).toEqual({ ok: false, reason: "forbidden" });

    const notOk = createCustomFieldsAdapters(fetchJson({}, 500));
    expect(await notOk.list()).toEqual({ ok: false, reason: "unavailable" });

    // SPA fallback HTML behind a misrouted proxy: unavailable, not a crash
    const badShape = createCustomFieldsAdapters(fetchJson({ fields: "everything" }));
    expect(await badShape.list()).toEqual({ ok: false, reason: "unavailable" });

    const offline = createCustomFieldsAdapters(() => Promise.reject(new Error("offline")));
    expect(await offline.list()).toEqual({ ok: false, reason: "unavailable" });
  });

  it("create: 201 parses; 409 reads as exists, 422 invalid_options as its own word", async () => {
    const ok = createCustomFieldsAdapters(fetchJson({ id: "f1" }, 201));
    expect(
      await ok.create({
        subjectType: "task",
        fieldKey: "po_number",
        label: "PO number",
        fieldType: "text",
        required: false,
        viewableBy: [],
        editableBy: [],
      }),
    ).toEqual({ ok: true, data: { id: "f1" } });

    const exists = createCustomFieldsAdapters(fetchJson({ error: "field_exists" }, 409));
    expect(
      await exists.create({
        subjectType: "task",
        fieldKey: "po_number",
        label: "PO number",
        fieldType: "text",
        required: false,
        viewableBy: [],
        editableBy: [],
      }),
    ).toEqual({ ok: false, reason: "exists" });

    const badOptions = createCustomFieldsAdapters(
      fetchJson({ error: "invalid_options" }, 422),
    );
    expect(
      await badOptions.create({
        subjectType: "task",
        fieldKey: "tier",
        label: "Tier",
        fieldType: "select",
        options: [],
        required: false,
        viewableBy: [],
        editableBy: [],
      }),
    ).toEqual({ ok: false, reason: "invalid_options" });

    const invalid = createCustomFieldsAdapters(fetchJson({ error: "invalid_request" }, 422));
    expect(
      await invalid.create({
        subjectType: "task",
        fieldKey: "po_number",
        label: "PO number",
        fieldType: "text",
        required: false,
        viewableBy: [],
        editableBy: [],
      }),
    ).toEqual({ ok: false, reason: "invalid" });

    const forbidden = createCustomFieldsAdapters(fetchJson({}, 403));
    expect(
      await forbidden.create({
        subjectType: "task",
        fieldKey: "po_number",
        label: "PO number",
        fieldType: "text",
        required: false,
        viewableBy: [],
        editableBy: [],
      }),
    ).toEqual({ ok: false, reason: "forbidden" });
  });

  it("update: 200 parses the field; 404/422 speak their words", async () => {
    const updated = { ...FIELD, label: "PO 编号", version: 2 };
    const ok = createCustomFieldsAdapters(fetchJson({ field: updated }));
    expect(await ok.update("f1", { label: "PO 编号" })).toEqual({ ok: true, data: updated });

    const notFound = createCustomFieldsAdapters(fetchJson({ error: "not_found" }, 404));
    expect(await notFound.update("f1", { label: "x" })).toEqual({
      ok: false,
      reason: "not_found",
    });

    const badOptions = createCustomFieldsAdapters(
      fetchJson({ error: "invalid_options" }, 422),
    );
    expect(await badOptions.update("f1", { options: [] })).toEqual({
      ok: false,
      reason: "invalid_options",
    });
  });

  it("history and rollback ride the custom_field_def family under the #226 ledger", async () => {
    let lastUrl = "";
    const recording: typeof fetch = vi.fn((input: RequestInfo | URL) => {
      lastUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            revisions: [
              {
                version: 2,
                source: "updated",
                changes: { label: { from: "a", to: "b" } },
                changedById: null,
                createdAt: "2026-10-07T00:00:00.000Z",
              },
            ],
          }),
          { status: 200 },
        ),
      );
    });
    const adapters = createCustomFieldsAdapters(recording);
    const history = await adapters.history("f1");
    expect(lastUrl).toBe(`/api/config-versions/${CUSTOM_FIELD_DEF_SUBJECT}/f1`);
    expect(history).toEqual({
      ok: true,
      data: [
        {
          version: 2,
          source: "updated",
          changes: { label: { from: "a", to: "b" } },
          changedById: null,
          createdAt: "2026-10-07T00:00:00.000Z",
        },
      ],
    });

    const rollbackOk = createCustomFieldsAdapters(
      fetchJson({ subjectType: "custom_field_def", subjectId: "f1", restoredVersion: 1, newVersion: 3 }),
    );
    expect(await rollbackOk.rollback("f1", 1, "restore label")).toEqual({
      ok: true,
      data: { subjectType: "custom_field_def", subjectId: "f1", restoredVersion: 1, newVersion: 3 },
    });

    let rollbackBody = "";
    const rollbackRecording: typeof fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body;
      if (typeof body === "string") rollbackBody = body;
      return Promise.resolve(
        new Response(
          JSON.stringify({ subjectType: "custom_field_def", subjectId: "f1", restoredVersion: 1, newVersion: 3 }),
          { status: 200 },
        ),
      );
    });
    await createCustomFieldsAdapters(rollbackRecording).rollback("f1", 1);
    expect(rollbackBody).toBe(JSON.stringify({ toVersion: 1 }));

    const noChange = createCustomFieldsAdapters(
      fetchJson({ error: "rollback_no_change" }, 409),
    );
    expect(await noChange.rollback("f1", 2)).toEqual({ ok: false, reason: "no_change" });
  });

  it("the mirrors keep the server enums honest: five field types, customer among the roles", () => {
    expect(FIELD_TYPES).toEqual(["text", "number", "boolean", "date", "select"]);
    expect(FIELD_ROLES).toContain("customer");
    expect(FIELD_ROLES).toHaveLength(15);
  });
});
