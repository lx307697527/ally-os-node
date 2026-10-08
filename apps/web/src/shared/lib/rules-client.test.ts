// The rules adapters' contracts, against a fake fetch — same discipline as
// numbering-client.test.ts: reads report the failure mode instead of
// flattening it, the change face carries its payloads (WHO may change — the
// 403's roles; WHY a value was rejected — the 400's issues verbatim), history
// and rollback speak the ledger's rejections, every parse is zod, and the
// display helpers stay liberal where the server stays strict.
import { describe, expect, it, vi } from "vitest";

import {
  addTableColumn,
  addTableRow,
  buildRuleValue,
  cellIssueKey,
  createRulesAdapters,
  emptyTableDraft,
  emptyValueDraft,
  filterRules,
  formatTableDraft,
  formatValueDraft,
  locateTableCellIssues,
  moveTableColumn,
  moveTableRow,
  parseDecisionTableDisplay,
  parseRefs,
  parseTableCellIssues,
  patchTableColumn,
  removeTableColumn,
  removeTableRow,
  serializeTableDraft,
  setTableCell,
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
  // the server's shape: an array of row maps, each row carrying its own _id
  rules: [
    { _id: "row_a", action: "'grant'", route: "'role.grant'" },
    { _id: "row_b", action: "'revoke'", route: "'role.revoke'" },
  ],
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
  it("draws columns inputs-then-outputs and rows in stored order (order = routing order)", () => {
    const display = parseDecisionTableDisplay(TABLE);
    expect(display).not.toBeNull();
    expect(display?.hitPolicy).toBe("first");
    expect(display?.columns.map((column) => column.kind)).toEqual(["input", "output"]);
    expect(display?.rows.map((row) => row.id)).toEqual(["row_a", "row_b"]);
  });

  it("regression: the server's array-shaped rules draw as a grid, not raw-JSON fallback", () => {
    // the parser used to read an object-keyed rules shape the server never
    // writes — every real value (0024 seed included) fell back to raw JSON
    const seeded = {
      hitPolicy: "first",
      inputs: [{ id: "in_action", field: "action", name: "Action" }],
      outputs: [{ id: "out_config", field: "configKey", name: "Approval line" }],
      rules: [
        { _id: "r-grant", in_action: "== 'grant'", out_config: "'role_grant'" },
        { _id: "r-revoke", in_action: "== 'revoke'", out_config: "'role_grant'" },
      ],
    };
    const display = parseDecisionTableDisplay(seeded);
    expect(display?.rows.map((row) => row.id)).toEqual(["r-grant", "r-revoke"]);
  });

  it("an empty table is a legal table (fail closed), not a fallback", () => {
    const display = parseDecisionTableDisplay({ hitPolicy: "first", inputs: [], outputs: [], rules: [] });
    expect(display).not.toBeNull();
    expect(display?.rows).toEqual([]);
  });

  it("a row without _id still draws under a generated label", () => {
    const display = parseDecisionTableDisplay({
      hitPolicy: "collect",
      inputs: [],
      outputs: [{ id: "route", field: "route" }],
      rules: [{ route: "'a'" }, { _id: "named", route: "'b'" }],
    });
    expect(display?.rows.map((row) => row.id)).toEqual(["row_1", "named"]);
  });

  it("anything not shaped like a table falls back to null — the page then shows raw JSON", () => {
    expect(parseDecisionTableDisplay(null)).toBeNull();
    expect(parseDecisionTableDisplay("no")).toBeNull();
    expect(parseDecisionTableDisplay([])).toBeNull();
    expect(parseDecisionTableDisplay({})).toBeNull();
    expect(parseDecisionTableDisplay({ hitPolicy: "first", inputs: "no", outputs: [], rules: [] })).toBeNull();
    expect(parseDecisionTableDisplay({ hitPolicy: "first", inputs: [], outputs: [], rules: {} })).toBeNull();
    expect(
      parseDecisionTableDisplay({ hitPolicy: "first", inputs: [], outputs: [], rules: [{ c: 7 }] }),
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

// ---------------------------------------------------------------------------
// Decision-table editor draft helpers (#233 JDM grid editor). The server's
// zod + compile probe stay the authority; these pin what the page refuses
// before the wire and that a grid save never rewrites a value it did not touch.
// ---------------------------------------------------------------------------

const STORED_TABLE = {
  hitPolicy: "first",
  inputs: [
    { id: "action", field: "action" },
    { id: "amount", field: "amount", name: "Amount" },
  ],
  outputs: [{ id: "route", field: "configKey" }],
  rules: [
    { _id: "row_a", action: "== 'grant'", amount: "> 100", route: "'role.grant'" },
    { _id: "row_b", action: "", amount: "", route: "'role.revoke'" },
  ],
};

describe("decision-table editor draft helpers (#233 grid editor)", () => {
  it("format → serialize round-trips a stored value unchanged", () => {
    const draft = formatTableDraft(STORED_TABLE);
    expect(draft).not.toBeNull();
    if (draft === null) return;
    expect(serializeTableDraft(draft)).toEqual({ ok: true, value: STORED_TABLE });
  });

  it("format keeps row array order — first-hit policy makes order the routing order", () => {
    const draft = formatTableDraft(STORED_TABLE);
    expect(draft).not.toBeNull();
    if (draft === null) return;
    expect(draft.rows.map((row) => row.id)).toEqual(["row_a", "row_b"]);
    // display agrees: stored order, never re-sorted
    expect(parseDecisionTableDisplay(STORED_TABLE)?.rows.map((row) => row.id)).toEqual([
      "row_a",
      "row_b",
    ]);
  });

  it("format returns null for values that are not table-shaped (JSON fallback)", () => {
    expect(formatTableDraft(null)).toBeNull();
    expect(formatTableDraft("nope")).toBeNull();
    expect(formatTableDraft({ ...STORED_TABLE, hitPolicy: "everything" })).toBeNull();
    expect(formatTableDraft({ ...STORED_TABLE, rules: {} })).toBeNull();
    expect(formatTableDraft({ ...STORED_TABLE, inputs: [{ id: "a" }] })).toBeNull();
    expect(
      formatTableDraft({ ...STORED_TABLE, rules: [{ _id: "r", action: 7 }] }),
    ).toBeNull();
    expect(formatTableDraft({ ...STORED_TABLE, outputs: [] })).toBeNull();
  });

  it("renaming a column id re-keys the cells on serialize — nothing is lost mid-keystroke", () => {
    const draft = formatTableDraft(STORED_TABLE);
    expect(draft).not.toBeNull();
    if (draft === null) return;
    const actionColumn = draft.columns.find((column) => column.id === "action");
    expect(actionColumn).toBeDefined();
    if (actionColumn === undefined) return;
    const renamed = patchTableColumn(draft, actionColumn.key, { id: "verb" });
    const out = serializeTableDraft(renamed);
    expect(out).toEqual({
      ok: true,
      value: {
        ...STORED_TABLE,
        inputs: [{ id: "verb", field: "action" }, STORED_TABLE.inputs[1]],
        rules: [
          { _id: "row_a", verb: "== 'grant'", amount: "> 100", route: "'role.grant'" },
          { _id: "row_b", verb: "", amount: "", route: "'role.revoke'" },
        ],
      },
    });
  });

  it("serialize mirrors the server's shape refusals before the wire", () => {
    const draft = formatTableDraft(STORED_TABLE);
    expect(draft).not.toBeNull();
    if (draft === null) return;
    const noOutputs = serializeTableDraft({ ...draft, columns: draft.columns.filter((c) => c.kind === "input") });
    expect(noOutputs.ok).toBe(false);
    if (noOutputs.ok) return;
    expect(noOutputs.issues.some((issue) => issue.includes("at least one output column"))).toBe(true);

    const duplicate = serializeTableDraft(
      patchTableColumn(draft, draft.columns[1]?.key ?? "", { id: "action" }),
    );
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) return;
    expect(duplicate.issues).toContain('Duplicate column id "action" — ids must be unique across inputs and outputs.');

    const emptied = serializeTableDraft(patchTableColumn(draft, draft.columns[0]?.key ?? "", { id: "  " }));
    expect(emptied.ok).toBe(false);
    if (emptied.ok) return;
    expect(emptied.issues).toContain("The input column needs a non-empty id.");
  });

  it("a cell whose column is gone blocks the save with a named issue instead of vanishing", () => {
    const draft = formatTableDraft({
      ...STORED_TABLE,
      rules: [
        { _id: "row_a", action: "== 'grant'", route: "'role.grant'", ghost: "'??'" },
      ],
    });
    expect(draft).not.toBeNull();
    if (draft === null) return;
    const out = serializeTableDraft(draft);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.issues).toEqual([
      'Row "row_a" has a cell for a column the table no longer has ("ghost") — switch to JSON mode to keep it.',
    ]);
  });

  it("removing a column drops its cells; the last output column refuses to leave", () => {
    const draft = formatTableDraft(STORED_TABLE);
    expect(draft).not.toBeNull();
    if (draft === null) return;
    const amountColumn = draft.columns.find((column) => column.id === "amount");
    expect(amountColumn).toBeDefined();
    if (amountColumn === undefined) return;
    const withoutAmount = removeTableColumn(draft, amountColumn.key);
    const out = serializeTableDraft(withoutAmount);
    expect(out).toEqual({
      ok: true,
      value: {
        ...STORED_TABLE,
        inputs: [STORED_TABLE.inputs[0]],
        rules: [
          { _id: "row_a", action: "== 'grant'", route: "'role.grant'" },
          { _id: "row_b", action: "", route: "'role.revoke'" },
        ],
      },
    });
    const routeColumn = draft.columns.find((column) => column.id === "route");
    expect(routeColumn).toBeDefined();
    if (routeColumn === undefined) return;
    expect(removeTableColumn(draft, routeColumn.key)).toBe(draft);
  });

  it("rows reorder for routing and ignore out-of-range drags", () => {
    const draft = formatTableDraft(STORED_TABLE);
    expect(draft).not.toBeNull();
    if (draft === null) return;
    const flipped = moveTableRow(draft, 0, 1);
    expect(flipped.rows.map((row) => row.id)).toEqual(["row_b", "row_a"]);
    expect(moveTableRow(draft, 0, 5)).toBe(draft);
    expect(moveTableRow(draft, 1, 1)).toBe(draft);
  });

  it("columns reorder within their kind — an input never crosses into the outputs", () => {
    const draft = formatTableDraft(STORED_TABLE);
    expect(draft).not.toBeNull();
    if (draft === null) return;
    const moved = moveTableColumn(draft, "input", 0, 1);
    expect(moved.columns.map((column) => column.id)).toEqual(["amount", "action", "route"]);
    // dragging the first input "to index 3" (past the output) does not cross
    expect(moveTableColumn(draft, "input", 0, 3)).toBe(draft);
  });

  it("add column/row generate collision-free ids; empty names stay omitted", () => {
    const draft = formatTableDraft(STORED_TABLE);
    expect(draft).not.toBeNull();
    if (draft === null) return;
    const withFirstInput = addTableColumn(draft, "input");
    expect(withFirstInput.columns.map((column) => column.id)).toEqual([
      "action",
      "amount",
      "route",
      "input_1",
    ]);
    const withSecondInput = addTableColumn(withFirstInput, "input");
    expect(withSecondInput.columns.map((column) => column.id)).toEqual([
      "action",
      "amount",
      "route",
      "input_1",
      "input_2",
    ]);
    const out = serializeTableDraft(withFirstInput);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const inputs = (out.value as { inputs: { name?: string }[] }).inputs;
    expect(inputs.map((column) => "name" in column)).toEqual([false, true, false]);
    expect((out.value as { outputs: { name?: string }[] }).outputs[0]?.name).toBeUndefined();

    const withRow = addTableRow(draft);
    expect(withRow.rows).toHaveLength(3);
    const rowOut = serializeTableDraft(withRow);
    expect(rowOut.ok).toBe(true);
    if (!rowOut.ok) return;
    const rules = (rowOut.value as { rules: Record<string, string>[] }).rules;
    expect(rules[2]?._id).toBe("row_1");
    expect(removeTableRow(withRow, withRow.rows[2]?.key ?? "")).toEqual(draft);
  });

  it("empty/duplicate row ids regenerate on serialize; cell edits land in the right slot", () => {
    const draft = emptyTableDraft();
    const withRow = addTableRow(draft);
    const edited = setTableCell(withRow, withRow.rows[0]?.key ?? "", draft.columns[0]?.key ?? "", "'x'");
    const out = serializeTableDraft(edited);
    expect(out).toEqual({
      ok: true,
      value: {
        hitPolicy: "first",
        inputs: [],
        outputs: [{ id: "output", field: "output" }],
        rules: [{ _id: "row_1", output: "'x'" }],
      },
    });

    const duplicated = { ...edited, rows: edited.rows.map((row) => ({ ...row, id: "same" })) };
    const duplicateOut = serializeTableDraft(addTableRow(duplicated));
    expect(duplicateOut.ok).toBe(true);
    if (!duplicateOut.ok) return;
    const ruleIds = (duplicateOut.value as { rules: Record<string, string>[] }).rules.map(
      (rule) => rule._id,
    );
    expect(new Set(ruleIds).size).toBe(ruleIds.length);
  });

  it("an empty table serializes legal — fail-closed until a row is added", () => {
    expect(serializeTableDraft(emptyTableDraft())).toEqual({
      ok: true,
      value: {
        hitPolicy: "first",
        inputs: [],
        outputs: [{ id: "output", field: "output" }],
        rules: [],
      },
    });
  });
});

describe("decision-table cell-issue locator (#233 grid editor)", () => {
  // Mirror of the server's compile-probe wording (apps/api/src/rules/
  // decision-table-schema.ts): InvalidDecisionTableError joins every per-cell
  // message with "; " behind the "rules: invalid decision table: " envelope,
  // and the route returns that whole string as issues[0].
  const ENVELOPE = "rules: invalid decision table: ";
  const badAction = `${ENVELOPE}rule "row_a" input cell "action" does not parse: {"type":"parserError","column":1,"row":1,"message":"extraneous input '=='"}`;
  const twoBadCells = `${ENVELOPE}rule "row_a" input cell "action" does not parse: {"type":"parserError","column":1}; rule "row_b" output cell "route" does not parse: {"type":"parserError","column":3}`;

  it("parses the server's per-cell wording into (rowId, columnId) refs", () => {
    const refs = parseTableCellIssues([badAction]);
    expect(refs).toEqual([
      {
        rowId: "row_a",
        columnId: "action",
        message: 'rule "row_a" input cell "action" does not parse: {"type":"parserError","column":1,"row":1,"message":"extraneous input \'==\'"}',
      },
    ]);
  });

  it("splits a joined refusal into one ref per named cell, envelope stripped", () => {
    const refs = parseTableCellIssues([twoBadCells]);
    expect(refs.map((ref) => [ref.rowId, ref.columnId])).toEqual([
      ["row_a", "action"],
      ["row_b", "route"],
    ]);
    expect(refs[0]?.message.startsWith('rule "row_a"')).toBe(true);
    expect(refs[1]?.message.startsWith('rule "row_b"')).toBe(true);
    expect(refs.some((ref) => ref.message.includes(ENVELOPE))).toBe(false);
    expect(refs.some((ref) => ref.message.endsWith(";"))).toBe(false);
  });

  it("locates refs onto the current draft's stable handles", () => {
    const draft = formatTableDraft(STORED_TABLE);
    expect(draft).not.toBeNull();
    if (draft === null) return;
    const actionColumn = draft.columns.find((column) => column.id === "action");
    const rowA = draft.rows.find((row) => row.id === "row_a");
    expect(actionColumn).toBeDefined();
    expect(rowA).toBeDefined();
    if (actionColumn === undefined || rowA === undefined) return;
    const located = locateTableCellIssues([badAction], draft);
    expect(located).toEqual([
      {
        rowKey: rowA.key,
        columnKey: actionColumn.key,
        message: 'rule "row_a" input cell "action" does not parse: {"type":"parserError","column":1,"row":1,"message":"extraneous input \'==\'"}',
      },
    ]);
    expect(cellIssueKey(located[0]?.rowKey ?? "", located[0]?.columnKey ?? "")).toBe(
      `${rowA.key}::${actionColumn.key}`,
    );
  });

  it("refs the grid cannot resolve (renamed/removed since the save) are dropped, not guessed", () => {
    const draft = formatTableDraft(STORED_TABLE);
    expect(draft).not.toBeNull();
    if (draft === null) return;
    expect(
      locateTableCellIssues(
        [`${ENVELOPE}rule "row_gone" input cell "action" does not parse: {"type":"parserError"}`],
        draft,
      ),
    ).toEqual([]);
    expect(
      locateTableCellIssues(
        [`${ENVELOPE}rule "row_a" input cell "col_gone" does not parse: {"type":"parserError"}`],
        draft,
      ),
    ).toEqual([]);
  });

  it("wording that is not the compile probe's names no cell (client refusals stay panel-only)", () => {
    const draft = formatTableDraft(STORED_TABLE);
    expect(draft).not.toBeNull();
    if (draft === null) return;
    expect(
      locateTableCellIssues(
        [
          'Duplicate column id "action" — ids must be unique across inputs and outputs.',
          "every rule needs a non-empty _id",
        ],
        draft,
      ),
    ).toEqual([]);
  });
});
