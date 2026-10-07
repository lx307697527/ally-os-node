// The workflow-template adapters' contracts, against a fake fetch — same
// discipline as numbering-client.test.ts: reads report the failure mode
// instead of flattening it, writes speak the kernel's specific rejections,
// and every response body is zod-parsed because API responses are external
// input as far as this bundle is concerned.
import { describe, expect, it, vi } from "vitest";

import { createWorkflowAdapters, type WorkflowTemplateRow } from "./workflow-client.ts";

function fetchJson(body: unknown, status = 200): typeof fetch {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

const LEAD_FLOW = {
  initial: "new",
  states: {
    new: { on: { CONTACT: "contacted" } },
    contacted: {},
  },
};

const TEMPLATE: WorkflowTemplateRow = {
  id: "t1",
  subjectType: "lead",
  templateKey: "standard",
  productType: null,
  isDefault: true,
  active: true,
  definition: LEAD_FLOW,
  version: 3,
  createdAt: "2026-10-01T00:00:00.000Z",
};

describe("workflow template adapters (#220 config face)", () => {
  it("list: parses the templates page; 403 reads as forbidden, everything else as unavailable", async () => {
    const ok = createWorkflowAdapters(fetchJson({ templates: [TEMPLATE] }));
    expect(await ok.list()).toEqual({ ok: true, data: [TEMPLATE] });

    const forbidden = createWorkflowAdapters(fetchJson({}, 403));
    expect(await forbidden.list()).toEqual({ ok: false, reason: "forbidden" });

    const notOk = createWorkflowAdapters(fetchJson({}, 500));
    expect(await notOk.list()).toEqual({ ok: false, reason: "unavailable" });

    // SPA fallback HTML behind a misrouted proxy: unavailable, not a crash
    const badShape = createWorkflowAdapters(fetchJson({ templates: "all of them" }));
    expect(await badShape.list()).toEqual({ ok: false, reason: "unavailable" });

    const offline = createWorkflowAdapters(() => Promise.reject(new Error("offline")));
    expect(await offline.list()).toEqual({ ok: false, reason: "unavailable" });
  });

  it("create: POSTs the full template body and maps the kernel's rejections", async () => {
    const fetchFn = fetchJson({ id: "new-1" }, 201);
    const adapters = createWorkflowAdapters(fetchFn);
    const input = {
      subjectType: "lead",
      templateKey: "standard",
      productType: null,
      isDefault: true,
      definition: LEAD_FLOW,
    };
    expect(await adapters.create(input)).toEqual({ ok: true, data: { id: "new-1" } });
    expect(fetchFn).toHaveBeenCalledWith("/api/workflow-templates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });

    const exists = createWorkflowAdapters(fetchJson({ error: "template_exists" }, 409));
    expect(await exists.create(input)).toEqual({ ok: false, reason: "exists" });

    const defaultTaken = createWorkflowAdapters(
      fetchJson({ error: "default_template_exists" }, 409),
    );
    expect(await defaultTaken.create(input)).toEqual({ ok: false, reason: "default_exists" });

    const forbidden = createWorkflowAdapters(fetchJson({}, 403));
    expect(await forbidden.create(input)).toEqual({ ok: false, reason: "forbidden" });

    const invalid = createWorkflowAdapters(
      fetchJson({ error: "invalid_definition", detail: `"done" --GO--> unknown target "ghost"` }, 422),
    );
    expect(await invalid.create(input)).toEqual({
      ok: false,
      reason: "invalid",
      detail: `"done" --GO--> unknown target "ghost"`,
    });

    const unknownBlock = createWorkflowAdapters(
      fetchJson({ error: "unknown_block", detail: { gates: [], actions: ["ghost_action"] } }, 422),
    );
    const blockFailure = await unknownBlock.create(input);
    expect(blockFailure.ok).toBe(false);
    if (!blockFailure.ok && blockFailure.reason === "invalid") {
      expect(blockFailure.detail).toContain("ghost_action");
    }

    expect(
      await createWorkflowAdapters(fetchJson({}, 400)).create(input),
    ).toEqual({ ok: false, reason: "invalid", detail: null });
    expect(
      await createWorkflowAdapters(fetchJson({}, 500)).create(input),
    ).toEqual({ ok: false, reason: "unavailable" });
  });

  it("update: PATCHes only the content fields and maps the kernel's rejections", async () => {
    const fetchFn = fetchJson({ template: TEMPLATE });
    const adapters = createWorkflowAdapters(fetchFn);
    const input = { active: false, definition: LEAD_FLOW };
    expect(await adapters.update("t1", input)).toEqual({ ok: true, data: TEMPLATE });
    expect(fetchFn).toHaveBeenCalledWith("/api/workflow-templates/t1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });

    const stale = createWorkflowAdapters(fetchJson({ error: "not_found" }, 404));
    expect(await stale.update("t1", input)).toEqual({ ok: false, reason: "not_found" });

    const defaultTaken = createWorkflowAdapters(
      fetchJson({ error: "default_template_exists" }, 409),
    );
    expect(await defaultTaken.update("t1", input)).toEqual({ ok: false, reason: "default_exists" });

    const forbidden = createWorkflowAdapters(fetchJson({}, 403));
    expect(await forbidden.update("t1", input)).toEqual({ ok: false, reason: "forbidden" });

    const invalid = createWorkflowAdapters(
      fetchJson({ error: "invalid_definition", detail: "template has no states" }, 422),
    );
    expect(await invalid.update("t1", input)).toEqual({
      ok: false,
      reason: "invalid",
      detail: "template has no states",
    });

    // No-change PATCH is idempotent on the server (returns the row, no ledger
    // entry) — the adapter reads that exactly like a change.
    const noChange = createWorkflowAdapters(fetchJson({ template: TEMPLATE }));
    expect(await noChange.update("t1", {})).toEqual({ ok: true, data: TEMPLATE });

    expect(
      await createWorkflowAdapters(fetchJson({}, 500)).update("t1", input),
    ).toEqual({ ok: false, reason: "unavailable" });
  });

  it("rows the server does not vouch for (missing fields, wrong types) read as unavailable", async () => {
    const damaged = createWorkflowAdapters(
      fetchJson({ templates: [{ ...TEMPLATE, version: "three" }] }),
    );
    expect(await damaged.list()).toEqual({ ok: false, reason: "unavailable" });
  });
});
