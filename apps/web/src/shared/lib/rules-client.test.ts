// The rules adapters' contracts, against a fake fetch — same discipline as
// numbering-client.test.ts: reads report the failure mode instead of
// flattening it, the change face carries its payloads (WHO may change — the
// 403's roles; WHY a value was rejected — the 400's issues verbatim), history
// and rollback speak the ledger's rejections, every parse is zod, and the
// display helpers stay liberal where the server stays strict.
import { describe, expect, it, vi } from "vitest";

import {
  buildRuleValue,
  createRulesAdapters,
  emptyValueDraft,
  filterRules,
  formatValueDraft,
  parseDecisionTableDisplay,
  parseRefs,
  valueSummary,
  type RuleView,
} from "./rules-client.ts";

function fetchJson(body: unknown, status = 200): typeof fetch {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

const RULE: RuleView = {
  id: "b692d0d1-59a3-4a1e-9a5a-0b6f3f7c1a01",
  key: "pricing.wastage_rate",
  label: "Wastage rate",
  category: "param",
  valueType: "number",
  value: 0.1,
  isSet: true,
  changeableBy: ["admin"],
  enableBy: null,
  adjudicationRefs: ["R-06-2"],
  riskFlag: false,
  riskNote: null,
  scheduled: null,
  counts: { triggers: 3, exceptions: 0, overrides: 0 },
  version: 2,
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const TABLE = {
  hitPolicy: "first",
  inputs: [{ id: "action", field: "action" }],
  outputs: [{ id: "route", field: "route" }],
  rules: {
    row_b: { action: "'revoke'", route: "'role.revoke'" },
    row_a: { action: "'grant'", route: "'role.grant'" },
  },
};

describe("rules adapters (#233)", () => {
  it("list: parses the registry page; other failures read as unavailable", async () => {
    const ok = createRulesAdapters(fetchJson({ rules: [RULE] }));
    expect(await ok.list()).toEqual({ ok: true, data: [RULE] });

    const notOk = createRulesAdapters(fetchJson({}, 500));
    expect(await notOk.list()).toEqual({ ok: false, reason: "unavailable" });

    const badShape = createRulesAdapters(fetchJson({ rules: "all of them" }));
    expect(await badShape.list()).toEqual({ ok: false, reason: "unavailable" });

    const offline = createRulesAdapters(() => Promise.reject(new Error("offline")));
    expect(await offline.list()).toEqual({ ok: false, reason: "unavailable" });
  });

  it("change: PATCHes value + rationale (+ optional future time) and returns the verdict", async () => {
    const fetchFn = fetchJson({
      mode: "immediate",
      changed: true,
      version: 3,
      rule: { ...RULE, value: 0.08, version: 3 },
    });
    const adapters = createRulesAdapters(fetchFn);
    const result = await adapters.change(RULE.key, {
      value: 0.08,
      rationale: { refs: ["R-06-2"], note: "new supplier quote" },
    });
    expect(result).toEqual({
      ok: true,
      data: { mode: "immediate", changed: true, version: 3, rule: { ...RULE, value: 0.08, version: 3 } },
    });
    expect(fetchFn).toHaveBeenCalledWith(`/api/rules/${encodeURIComponent(RULE.key)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: 0.08, rationale: { refs: ["R-06-2"], note: "new supplier quote" } }),
    });

    const scheduled = await createRulesAdapters(
      fetchJson({ mode: "scheduled", changed: true, effectiveAt: "2026-12-01T00:00:00.000Z", rule: RULE }),
    ).change(RULE.key, {
      value: 0.08,
      rationale: { refs: ["R-06-2"] },
      effectiveAt: "2026-12-01T00:00:00.000Z",
    });
    expect(scheduled).toEqual({
      ok: true,
      data: { mode: "scheduled", changed: true, effectiveAt: "2026-12-01T00:00:00.000Z", rule: RULE },
    });
  });

  it("change: the 403 names who may change, the 400 passes the issues verbatim", async () => {
    const forbidden = await createRulesAdapters(
      fetchJson({ error: "forbidden", code: "role_required", roles: ["admin", "sales_lead"] }, 403),
    ).change(RULE.key, { value: 1, rationale: { refs: ["x"] } });
    expect(forbidden).toEqual({ ok: false, reason: "forbidden", roles: ["admin", "sales_lead"] });

    const invalid = await createRulesAdapters(
      fetchJson(
        {
          error: "invalid_value",
          issues: ['rule "row_1" input cell "action" does not parse: {"type":"parserError"}'],
        },
        400,
      ),
    ).change(RULE.key, { value: TABLE, rationale: { refs: ["x"] } });
    expect(invalid).toEqual({
      ok: false,
      reason: "invalid",
      issues: ['rule "row_1" input cell "action" does not parse: {"type":"parserError"}'],
    });

    const pastTime = await createRulesAdapters(fetchJson({ error: "invalid_effective_time" }, 400)).change(
      RULE.key,
      { value: 1, rationale: { refs: ["x"] }, effectiveAt: "2020-01-01T00:00:00.000Z" },
    );
    expect(pastTime).toEqual({ ok: false, reason: "invalid_effective_time" });

    expect(
      await createRulesAdapters(fetchJson({ error: "rule_not_found" }, 404)).change("gone", {
        value: 1,
        rationale: { refs: ["x"] },
      }),
    ).toEqual({ ok: false, reason: "not_found" });

    expect(
      await createRulesAdapters(fetchJson({}, 500)).change(RULE.key, { value: 1, rationale: { refs: ["x"] } }),
    ).toEqual({ ok: false, reason: "unavailable" });
  });

  it("history: the rule's ledger behind the rules.configure gate", async () => {
    const revisions = [
      {
        version: 1,
        source: "created",
        changes: [],
        changedById: null,
        createdAt: "2026-09-30T00:00:00.000Z",
      },
      {
        version: 2,
        source: "updated",
        changes: [{ path: "value", from: 0.12, to: 0.1 }],
        changedById: "9a1b2c3d-0000-0000-0000-000000000000",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ];
    const ok = createRulesAdapters(fetchJson({ subjectType: "registry_rule", subjectId: RULE.id, revisions }));
    expect(await ok.history(RULE.id)).toEqual({ ok: true, data: revisions });

    const forbidden = createRulesAdapters(
      fetchJson({ error: "forbidden", code: "permission_required", permission: "rules.configure" }, 403),
    );
    expect(await forbidden.history(RULE.id)).toEqual({ ok: false, reason: "forbidden" });

    const unavailable = createRulesAdapters(fetchJson({}, 500));
    expect(await unavailable.history(RULE.id)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("rollback: POSTs to the ledger, maps no_change / unsupported / not_found", async () => {
    const fetchFn = fetchJson({
      subjectType: "registry_rule",
      subjectId: RULE.id,
      restoredVersion: 1,
      newVersion: 3,
      changes: [{ path: "value", from: 0.1, to: 0.12 }],
    });
    const result = await createRulesAdapters(fetchFn).rollback(RULE.id, 1, "wrong number on record");
    expect(result).toEqual({
      ok: true,
      data: {
        subjectType: "registry_rule",
        subjectId: RULE.id,
        restoredVersion: 1,
        newVersion: 3,
        changes: [{ path: "value", from: 0.1, to: 0.12 }],
      },
    });
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/config-versions/registry_rule/${encodeURIComponent(RULE.id)}/rollback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toVersion: 1, reason: "wrong number on record" }),
      },
    );

    expect(await createRulesAdapters(fetchJson({ error: "rollback_no_change" }, 409)).rollback(RULE.id, 2)).toEqual({
      ok: false,
      reason: "no_change",
    });
    expect(
      await createRulesAdapters(fetchJson({ error: "rollback_unsupported" }, 409)).rollback(RULE.id, 1),
    ).toEqual({ ok: false, reason: "unsupported" });
    expect(
      await createRulesAdapters(fetchJson({ error: "revision_not_found" }, 404)).rollback(RULE.id, 99),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(await createRulesAdapters(fetchJson({}, 403)).rollback(RULE.id, 1)).toEqual({
      ok: false,
      reason: "forbidden",
    });
  });
});

describe("decision-table display (liberal where the server is strict)", () => {
  it("draws columns inputs-then-outputs and rows sorted by _id", () => {
    const display = parseDecisionTableDisplay(TABLE);
    expect(display).not.toBeNull();
    expect(display?.hitPolicy).toBe("first");
    expect(display?.columns.map((column) => column.kind)).toEqual(["input", "output"]);
    expect(display?.rows.map((row) => row.id)).toEqual(["row_a", "row_b"]);
  });

  it("an empty table is a legal table (fail closed), not a fallback", () => {
    const display = parseDecisionTableDisplay({ hitPolicy: "first", inputs: [], outputs: [], rules: {} });
    expect(display).not.toBeNull();
    expect(display?.rows).toEqual([]);
  });

  it("anything not shaped like a table falls back to null — the page then shows raw JSON", () => {
    expect(parseDecisionTableDisplay(null)).toBeNull();
    expect(parseDecisionTableDisplay("no")).toBeNull();
    expect(parseDecisionTableDisplay([])).toBeNull();
    expect(parseDecisionTableDisplay({})).toBeNull();
    expect(parseDecisionTableDisplay({ hitPolicy: "first", inputs: "no", outputs: [], rules: {} })).toBeNull();
    expect(
      parseDecisionTableDisplay({ hitPolicy: "first", inputs: [], outputs: [], rules: { r: { c: 7 } } }),
    ).toBeNull();
  });
});

describe("value summary and filters", () => {
  it("summarizes by type — pending for null, on/off, counts for lists, rows for tables", () => {
    expect(valueSummary("number", null)).toBe("Pending fill-in");
    expect(valueSummary("number", 0.08)).toBe("0.08");
    expect(valueSummary("boolean", true)).toBe("On");
    expect(valueSummary("boolean", false)).toBe("Off");
    expect(valueSummary("text", "30 days")).toBe('"30 days"');
    expect(valueSummary("string_list", ["a", "b"])).toBe("2 items");
    expect(valueSummary("number_list", [1])).toBe("1 item");
    expect(valueSummary("json", { k: 1 })).toBe("JSON object");
    expect(valueSummary("decision_table", TABLE)).toBe("Table — 2 rows, first");
    expect(valueSummary("decision_table", { nope: true })).toBe("Decision table");
  });

  const RULES: RuleView[] = [
    RULE,
    {
      ...RULE,
      id: "b692d0d1-59a3-4a1e-9a5a-0b6f3f7c1a02",
      key: "gates.business_exception_enabled",
      label: "Business gate exceptions",
      category: "switch",
      valueType: "boolean",
      value: false,
      isSet: true,
      riskFlag: true,
      adjudicationRefs: ["R-16-8"],
    },
    {
      ...RULE,
      id: "b692d0d1-59a3-4a1e-9a5a-0b6f3f7c1a03",
      key: "pricing.storage_rate",
      label: "Storage rate",
      category: "param",
      valueType: "number",
      value: null,
      isSet: false,
    },
  ];

  it("filters by text (key, label, basis ref), kind, and pending-only", () => {
    expect(filterRules(RULES, { query: "", category: "all", pendingOnly: false })).toHaveLength(3);
    expect(filterRules(RULES, { query: "wastage", category: "all", pendingOnly: false })).toEqual([RULE]);
    expect(filterRules(RULES, { query: "r-16", category: "all", pendingOnly: false })).toHaveLength(1);
    expect(filterRules(RULES, { query: "", category: "switch", pendingOnly: false })).toHaveLength(1);
    expect(filterRules(RULES, { query: "", category: "all", pendingOnly: true })).toHaveLength(1);
    expect(filterRules(RULES, { query: "   ", category: "all", pendingOnly: false })).toHaveLength(3);
  });
});

describe("the change form's draft", () => {
  it("round-trips each type through format → build", () => {
    expect(buildRuleValue("number", formatValueDraft("number", 0.08))).toEqual({ ok: true, value: 0.08 });
    expect(buildRuleValue("text", formatValueDraft("text", "30 days"))).toEqual({ ok: true, value: "30 days" });
    expect(buildRuleValue("boolean", formatValueDraft("boolean", false))).toEqual({ ok: true, value: false });
    expect(buildRuleValue("string_list", formatValueDraft("string_list", ["a", "b"]))).toEqual({
      ok: true,
      value: ["a", "b"],
    });
    expect(buildRuleValue("number_list", formatValueDraft("number_list", [1, 2.5]))).toEqual({
      ok: true,
      value: [1, 2.5],
    });
    expect(buildRuleValue("json", formatValueDraft("json", { k: 1 }))).toEqual({ ok: true, value: { k: 1 } });
    expect(buildRuleValue("decision_table", formatValueDraft("decision_table", TABLE))).toEqual({
      ok: true,
      value: TABLE,
    });
  });

  it("refuses broken drafts before they reach the wire", () => {
    expect(buildRuleValue("number", { ...emptyValueDraft(false), numberValue: "abc" })).toEqual({
      ok: false,
      error: "The value must be a number.",
    });
    expect(buildRuleValue("text", { ...emptyValueDraft(false), textValue: "  " })).toEqual({
      ok: false,
      error: "The value must not be empty.",
    });
    expect(buildRuleValue("string_list", emptyValueDraft(false))).toEqual({
      ok: false,
      error: "Enter at least one list item — one per line.",
    });
    expect(buildRuleValue("number_list", { ...emptyValueDraft(false), listText: "1\nx" })).toEqual({
      ok: false,
      error: "Every line must be a number.",
    });
    expect(buildRuleValue("json", { ...emptyValueDraft(false), jsonText: "{nope" })).toEqual({
      ok: false,
      error: "The value must be valid JSON.",
    });
    expect(buildRuleValue("json", { ...emptyValueDraft(false), jsonText: "[1]" })).toEqual({
      ok: false,
      error: "The value must be a JSON object.",
    });
  });

  it("clear back to pending is a value (null), but never for a switch", () => {
    expect(buildRuleValue("number", { ...emptyValueDraft(false), clearToPending: true })).toEqual({
      ok: true,
      value: null,
    });
    expect(buildRuleValue("boolean", { ...emptyValueDraft(false), clearToPending: true })).toEqual({
      ok: false,
      error: "A switch is either on or off — it cannot go back to pending fill-in.",
    });
  });

  it("refs are one per line, trimmed, empties dropped", () => {
    expect(parseRefs("R-06-2\n  owner decision 2026-09-30 \n\n")).toEqual([
      "R-06-2",
      "owner decision 2026-09-30",
    ]);
    expect(parseRefs("   ")).toEqual([]);
  });
});
