// The approval-config adapters' contracts, against a fake fetch — same
// discipline as numbering-client.test.ts: reads report the failure mode
// instead of flattening it, writes speak the kernel's specific rejections,
// every parse is zod, and the client's role/mode/meaning vocabularies stay
// pinned to the server enums they mirror.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  APPROVAL_CONFIG_SUBJECT,
  APPROVAL_LEVEL_MODES,
  APPROVAL_ROLES,
  APPROVAL_SIGNATURE_MEANINGS,
  createApprovalConfigAdapters,
  type ApprovalConfigRow,
  type ApprovalLevel,
} from "./approval-config-client.ts";

const SRC = dirname(fileURLToPath(import.meta.url));

function fetchJson(body: unknown, status = 200): typeof fetch {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

const LEVEL: ApprovalLevel = {
  name: "lead review",
  users: ["u1"],
  roles: ["sales_lead"],
  mode: "any",
  requireSignature: false,
  signatureMeaning: "approved",
};

const CONFIG: ApprovalConfigRow = {
  id: "c1",
  subjectType: "quote_discount",
  configKey: "discount_line",
  name: "Discount line",
  levels: [LEVEL],
  active: true,
  version: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
};

describe("approval-config adapters (#221)", () => {
  it("list: parses the configs page; 403 reads as forbidden, other failures as unavailable", async () => {
    const ok = createApprovalConfigAdapters(fetchJson({ configs: [CONFIG] }));
    expect(await ok.list()).toEqual({ ok: true, data: [CONFIG] });

    const forbidden = createApprovalConfigAdapters(fetchJson({}, 403));
    expect(await forbidden.list()).toEqual({ ok: false, reason: "forbidden" });

    const notOk = createApprovalConfigAdapters(fetchJson({}, 500));
    expect(await notOk.list()).toEqual({ ok: false, reason: "unavailable" });

    const badShape = createApprovalConfigAdapters(fetchJson({ configs: "all of them" }));
    expect(await badShape.list()).toEqual({ ok: false, reason: "unavailable" });

    const offline = createApprovalConfigAdapters(() => Promise.reject(new Error("offline")));
    expect(await offline.list()).toEqual({ ok: false, reason: "unavailable" });
  });

  it("directory: parses the staff list behind the session face", async () => {
    const ok = createApprovalConfigAdapters(
      fetchJson({ assignees: [{ id: "u1", name: "Bob", email: "bob@example.com" }] }),
    );
    expect(await ok.directory()).toEqual({
      ok: true,
      data: [{ id: "u1", name: "Bob", email: "bob@example.com" }],
    });
    const notOk = createApprovalConfigAdapters(fetchJson({}, 500));
    expect(await notOk.directory()).toEqual({ ok: false, reason: "unavailable" });
  });

  it("create: 201 carries the id; 409 reads as a taken key, 422 as rejected levels", async () => {
    const input = {
      subjectType: "quote_discount",
      configKey: "discount_line",
      name: "Discount line",
      levels: [LEVEL],
    };
    const ok = createApprovalConfigAdapters(fetchJson({ id: "c9" }, 201));
    expect(await ok.create(input)).toEqual({ ok: true, data: { id: "c9" } });

    const exists = createApprovalConfigAdapters(fetchJson({ error: "config_exists" }, 409));
    expect(await exists.create(input)).toEqual({ ok: false, reason: "exists" });

    const badLevels = createApprovalConfigAdapters(
      fetchJson({ error: "invalid_levels", detail: [] }, 422),
    );
    expect(await badLevels.create(input)).toEqual({ ok: false, reason: "invalid_levels" });

    const badBody = createApprovalConfigAdapters(fetchJson({ error: "invalid_request" }, 400));
    expect(await badBody.create(input)).toEqual({ ok: false, reason: "invalid" });
  });

  it("update: PATCH returns the rewritten row; 404 reads as a line gone", async () => {
    const patched = { ...CONFIG, name: "Renamed", version: 2, active: false };
    const ok = createApprovalConfigAdapters(fetchJson({ config: patched }));
    expect(await ok.update("c1", { name: "Renamed", active: false })).toEqual({
      ok: true,
      data: patched,
    });

    const missing = createApprovalConfigAdapters(fetchJson({ error: "not_found" }, 404));
    expect(await missing.update("c1", { active: false })).toEqual({ ok: false, reason: "not_found" });

    const badLevels = createApprovalConfigAdapters(fetchJson({ error: "invalid_levels" }, 422));
    expect(await badLevels.update("c1", { levels: [] })).toEqual({
      ok: false,
      reason: "invalid_levels",
    });
  });

  it("history and rollback speak the #226 ledger's specific rejections", async () => {
    const history = createApprovalConfigAdapters(
      fetchJson({
        revisions: [
          { version: 2, source: "updated", changes: { name: { from: "a", to: "b" } }, changedById: "u1", createdAt: "2026-10-02T00:00:00.000Z" },
          { version: 1, source: "created", changes: null, changedById: "u1", createdAt: "2026-10-01T00:00:00.000Z" },
        ],
      }),
    );
    expect(await history.history("c1")).toEqual({
      ok: true,
      data: [
        { version: 2, source: "updated", changes: { name: { from: "a", to: "b" } }, changedById: "u1", createdAt: "2026-10-02T00:00:00.000Z" },
        { version: 1, source: "created", changes: null, changedById: "u1", createdAt: "2026-10-01T00:00:00.000Z" },
      ],
    });

    const rolled = createApprovalConfigAdapters(
      fetchJson({ subjectType: APPROVAL_CONFIG_SUBJECT, subjectId: "c1", restoredVersion: 1, newVersion: 3 }),
    );
    expect(await rolled.rollback("c1", 1)).toEqual({
      ok: true,
      data: { subjectType: APPROVAL_CONFIG_SUBJECT, subjectId: "c1", restoredVersion: 1, newVersion: 3 },
    });

    const noChange = createApprovalConfigAdapters(fetchJson({ error: "rollback_no_change" }, 409));
    expect(await noChange.rollback("c1", 2)).toEqual({ ok: false, reason: "no_change" });

    const unsupported = createApprovalConfigAdapters(fetchJson({ error: "rollback_unsupported" }, 409));
    expect(await unsupported.rollback("c1", 1)).toEqual({ ok: false, reason: "unsupported" });

    const missing = createApprovalConfigAdapters(fetchJson({ error: "revision_not_found" }, 404));
    expect(await missing.rollback("c1", 9)).toEqual({ ok: false, reason: "not_found" });
  });

  it("vocabularies mirror the server enums the kernel enforces", () => {
    // customer is a valid role word but never a valid approver — the editor
    // must not offer it (the server refine refuses it either way).
    expect(APPROVAL_ROLES).not.toContain("customer");
    expect(APPROVAL_ROLES).toContain("owner");
    expect(APPROVAL_ROLES).toContain("finance");
    expect(APPROVAL_LEVEL_MODES).toEqual(["any", "all", "quorum"]);
    expect(APPROVAL_SIGNATURE_MEANINGS).toEqual(["reviewed", "approved"]);
  });

  it("source text keeps the role mirror in step with the server's ROLES list", () => {
    // jsdom-free repo: the server enum is read as source text here (the api
    // package is not a web dependency) — the mirror adds no role of its own.
    const server = readFileSync(
      join(SRC, "..", "..", "..", "..", "api", "src", "authz", "permissions.ts"),
      "utf8",
    );
    const serverRoles = /export const ROLES = \[([^\]]+)\]/.exec(server);
    expect(serverRoles).not.toBeNull();
    const rolesBody = must(serverRoles)[1];
    const names = must(rolesBody)
      .split(",")
      .map((entry) => entry.trim().replace(/^"|"$/g, ""))
      .filter((entry) => entry.length > 0);
    expect(names.filter((role) => role !== "customer")).toEqual([...APPROVAL_ROLES]);
  });
});

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("unexpected missing value");
  return value;
}
