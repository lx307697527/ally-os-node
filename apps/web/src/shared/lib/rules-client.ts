// The rules registry' data access (#233 config face). The registry is the one
// place in the configuration studio where the family permission is NOT the
// write right: every authenticated operator can READ the rules (they are the
// company's shared business parameters), while each rule's PATCH is adjudicated
// per-rule by its changeableBy/enableBy roles. So unlike the numbering page,
// the failure payloads carry data — WHO may change it (403 roles), WHY a value
// was rejected (400 issues, the decision-table compile probe's per-cell
// messages verbatim) — and the page speaks them instead of a generic "no".
//
//   { ok: true, data }                          — the call worked
//   { ok: false, reason: "forbidden", roles }   — 403 role_required (+ who may)
//   { ok: false, reason: "unavailable" }        — network/5xx/unparseable body
// and the change face adds the kernel's specific rejections. Response bodies
// are zod-parsed because API responses are external input as far as this
// bundle is concerned.
//
// There is deliberately NO create face and NO drafts face: hard bottom lines
// never get rows (the registry holds only what an adjudication put there), and
// the registry_rule config family answers drafts with 409 publish_unsupported
// — history and rollback via the #226 ledger are the studio's full write
// surface beyond the per-rule value change.
import { z } from "zod";

export const RULE_CATEGORIES = ["param", "switch", "gate"] as const;
export type RuleCategory = (typeof RULE_CATEGORIES)[number];

export const RULE_VALUE_TYPES = [
  "number",
  "text",
  "boolean",
  "string_list",
  "number_list",
  "json",
  "decision_table",
] as const;
export type RuleValueType = (typeof RULE_VALUE_TYPES)[number];

const scheduledSchema = z.object({
  value: z.unknown(),
  effectiveAt: z.string(),
  rationale: z.object({
    refs: z.array(z.string()),
    note: z.string().optional(),
  }),
  byId: z.string().nullable(),
});

const ruleViewSchema = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  category: z.enum(RULE_CATEGORIES),
  valueType: z.enum(RULE_VALUE_TYPES),
  value: z.unknown(),
  isSet: z.boolean(),
  changeableBy: z.array(z.string()),
  enableBy: z.array(z.string()).nullable(),
  adjudicationRefs: z.array(z.string()),
  riskFlag: z.boolean(),
  riskNote: z.string().nullable(),
  scheduled: scheduledSchema.nullable(),
  counts: z.object({
    triggers: z.number(),
    exceptions: z.number(),
    overrides: z.number(),
  }),
  version: z.number(),
  updatedAt: z.string(),
});

const rulesPageSchema = z.object({ rules: z.array(ruleViewSchema) });

const changeResponseSchema = z.object({
  mode: z.enum(["immediate", "scheduled"]),
  changed: z.boolean(),
  version: z.number().optional(),
  effectiveAt: z.string().optional(),
  rule: ruleViewSchema,
});

const pathChangeSchema = z.object({
  path: z.string(),
  from: z.unknown(),
  to: z.unknown(),
});

const revisionsResponseSchema = z.object({
  subjectType: z.string(),
  subjectId: z.string(),
  revisions: z.array(
    z.object({
      version: z.number(),
      source: z.string(),
      changes: z.array(pathChangeSchema),
      changedById: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});

const rollbackResponseSchema = z.object({
  subjectType: z.string(),
  subjectId: z.string(),
  restoredVersion: z.number(),
  newVersion: z.number(),
  changes: z.array(pathChangeSchema),
});

export type RuleView = z.infer<typeof ruleViewSchema>;
export type RuleRevision = z.infer<(typeof revisionsResponseSchema)["shape"]["revisions"]["element"]>;
export type PathChange = z.infer<typeof pathChangeSchema>;

/** The config-ledger family name the rule ledger rows live under (#226). */
export const REGISTRY_RULE_SUBJECT = "registry_rule";

export type RuleReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "forbidden" | "unavailable" };

/** The change face's rejections carry their payloads: the 403 names the roles
 *  that may change the rule (owner is always implicit), the 400 passes the
 *  server's issues verbatim — for decision tables those are the compile
 *  probe's per-cell parser errors, which is exactly what the editor should
 *  show instead of a generic "invalid". */
export type RuleChangeResult =
  | { ok: true; data: z.infer<typeof changeResponseSchema> }
  | { ok: false; reason: "forbidden"; roles: string[] }
  | { ok: false; reason: "invalid"; issues: string[] }
  | { ok: false; reason: "invalid_effective_time" }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "unavailable" };

export type RuleRollbackResult =
  | { ok: true; data: z.infer<typeof rollbackResponseSchema> }
  | { ok: false; reason: "forbidden" }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "no_change" }
  | { ok: false; reason: "unsupported" }
  | { ok: false; reason: "unavailable" };

export interface RuleChangeInput {
  value: unknown;
  rationale: { refs: string[]; note?: string };
  /** ISO instant — omit for an immediate change. */
  effectiveAt?: string;
}

async function readJson<T>(
  fetchFn: typeof fetch,
  schema: z.ZodType<T>,
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: T | null; error: string | null; raw: unknown }> {
  try {
    const res = await fetchFn(url, init);
    const raw: unknown = await res.json().catch(() => null);
    const parsed = schema.safeParse(raw);
    return {
      status: res.status,
      body: parsed.success ? parsed.data : null,
      raw,
      error:
        typeof raw === "object" && raw !== null && "error" in raw
          ? String(raw.error)
          : null,
    };
  } catch {
    return { status: 0, body: null, error: null, raw: null };
  }
}

/** The 400 invalid_value body's issues array, pulled out of the raw body the
 *  strict response schema deliberately does not describe (it is an error
 *  shape, not a success shape). */
function issuesFrom(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const issues = (raw as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter((issue): issue is string => typeof issue === "string");
}

function rolesFrom(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const roles = (raw as { roles?: unknown }).roles;
  if (!Array.isArray(roles)) return [];
  return roles.filter((role): role is string => typeof role === "string");
}

export interface RulesAdapters {
  list(): Promise<RuleReadResult<RuleView[]>>;
  change(key: string, input: RuleChangeInput): Promise<RuleChangeResult>;
  history(subjectId: string): Promise<RuleReadResult<RuleRevision[]>>;
  rollback(
    subjectId: string,
    toVersion: number,
    reason?: string,
  ): Promise<RuleRollbackResult>;
}

export function createRulesAdapters(fetchFn: typeof fetch = fetch): RulesAdapters {
  return {
    async list() {
      const res = await readJson(fetchFn, rulesPageSchema, "/api/rules");
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status !== 200 || res.body === null) {
        return { ok: false as const, reason: "unavailable" as const };
      }
      return { ok: true as const, data: res.body.rules };
    },

    async change(key, input) {
      const body: Record<string, unknown> = { value: input.value, rationale: input.rationale };
      if (input.effectiveAt !== undefined) body.effectiveAt = input.effectiveAt;
      const res = await readJson(
        fetchFn,
        changeResponseSchema,
        `/api/rules/${encodeURIComponent(key)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (res.status === 403) {
        return { ok: false as const, reason: "forbidden" as const, roles: rolesFrom(res.raw) };
      }
      if (res.status === 404) return { ok: false as const, reason: "not_found" as const };
      if (res.status === 400 && res.error === "invalid_effective_time") {
        return { ok: false as const, reason: "invalid_effective_time" as const };
      }
      if (res.status === 400 && res.error === "invalid_value") {
        return { ok: false as const, reason: "invalid" as const, issues: issuesFrom(res.raw) };
      }
      if (res.status === 200 && res.body !== null) {
        return { ok: true as const, data: res.body };
      }
      return { ok: false as const, reason: "unavailable" as const };
    },

    async history(subjectId) {
      const res = await readJson(
        fetchFn,
        revisionsResponseSchema,
        `/api/config-versions/${REGISTRY_RULE_SUBJECT}/${encodeURIComponent(subjectId)}`,
      );
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status !== 200 || res.body === null) {
        return { ok: false as const, reason: "unavailable" as const };
      }
      return { ok: true as const, data: res.body.revisions };
    },

    async rollback(subjectId, toVersion, reason) {
      const body: Record<string, unknown> = { toVersion };
      if (reason !== undefined) body.reason = reason;
      const res = await readJson(
        fetchFn,
        rollbackResponseSchema,
        `/api/config-versions/${REGISTRY_RULE_SUBJECT}/${encodeURIComponent(subjectId)}/rollback`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status === 404) return { ok: false as const, reason: "not_found" as const };
      if (res.status === 409 && res.error === "rollback_no_change") {
        return { ok: false as const, reason: "no_change" as const };
      }
      if (res.status === 409 && res.error === "rollback_unsupported") {
        return { ok: false as const, reason: "unsupported" as const };
      }
      if (res.status === 200 && res.body !== null) {
        return { ok: true as const, data: res.body };
      }
      return { ok: false as const, reason: "unavailable" as const };
    },
  };
}

// ---------------------------------------------------------------------------
// Display-side pure helpers — the page renders through these so they are unit-
// testable without a DOM. They are LIBERAL on purpose: display never plays
// validator. The server's zod + decision-table compile probe are the only
// authorities over what a value may be; a value this parser cannot draw falls
// back to raw JSON in the page, never to a made-up shape.
// ---------------------------------------------------------------------------

/** A decision-table value as the grid draws it — columns in declaration
 *  order (inputs then outputs), rows sorted by their `_id`. `null` when the
 *  value is not shaped like a table at all; the page then shows raw JSON. */
export interface DecisionTableDisplay {
  hitPolicy: string;
  columns: { id: string; field: string; name: string | null; kind: "input" | "output" }[];
  rows: { id: string; cells: Record<string, string> }[];
}

export function parseDecisionTableDisplay(value: unknown): DecisionTableDisplay | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const table = value as {
    hitPolicy?: unknown;
    inputs?: unknown;
    outputs?: unknown;
    rules?: unknown;
  };
  if (typeof table.hitPolicy !== "string") return null;
  if (!Array.isArray(table.inputs) || !Array.isArray(table.outputs)) return null;
  if (typeof table.rules !== "object" || table.rules === null || Array.isArray(table.rules)) {
    return null;
  }
  const inputColumns: unknown[] = table.inputs;
  const outputColumns: unknown[] = table.outputs;
  const columns: DecisionTableDisplay["columns"] = [];
  for (const raw of [...inputColumns, ...outputColumns]) {
    if (typeof raw !== "object" || raw === null) return null;
    const column = raw as { id?: unknown; field?: unknown; name?: unknown };
    if (typeof column.id !== "string" || typeof column.field !== "string") return null;
    const isInput = inputColumns.includes(raw);
    columns.push({
      id: column.id,
      field: column.field,
      name: typeof column.name === "string" ? column.name : null,
      kind: isInput ? "input" : "output",
    });
  }
  const rows: DecisionTableDisplay["rows"] = [];
  for (const [rowId, rawCells] of Object.entries(table.rules as Record<string, unknown>)) {
    if (typeof rawCells !== "object" || rawCells === null) return null;
    const cells: Record<string, string> = {};
    for (const [columnId, cell] of Object.entries(rawCells as Record<string, unknown>)) {
      if (typeof cell !== "string") return null;
      cells[columnId] = cell;
    }
    rows.push({ id: rowId, cells });
  }
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { hitPolicy: table.hitPolicy, columns, rows };
}

/** One line for the list's value column — never the whole value (a decision
 *  table can be hundreds of cells); the detail panel draws the rest. */
export function valueSummary(valueType: RuleValueType, value: unknown): string {
  if (value === null || value === undefined) return "Pending fill-in";
  switch (valueType) {
    case "boolean":
      return value === true ? "On" : "Off";
    case "number":
      return typeof value === "number" ? String(value) : "Unreadable value";
    case "text":
      return typeof value === "string" ? `"${value}"` : "Unreadable value";
    case "string_list":
    case "number_list":
      return Array.isArray(value) ? `${value.length} item${value.length === 1 ? "" : "s"}` : "Unreadable value";
    case "json":
      return "JSON object";
    case "decision_table": {
      const display = parseDecisionTableDisplay(value);
      return display === null
        ? "Decision table"
        : `Table — ${display.rows.length} row${display.rows.length === 1 ? "" : "s"}, ${display.hitPolicy}`;
    }
  }
}

export interface RuleFilters {
  query: string;
  category: RuleCategory | "all";
  pendingOnly: boolean;
}

/** The list's filter — a rule survives when it matches the text (key, label,
 *  or adjudication ref), the category, and the pending-fill-in toggle. */
export function filterRules(rules: RuleView[], filters: RuleFilters): RuleView[] {
  const query = filters.query.trim().toLowerCase();
  return rules.filter((rule) => {
    if (filters.category !== "all" && rule.category !== filters.category) return false;
    if (filters.pendingOnly && rule.isSet) return false;
    if (query === "") return true;
    return (
      rule.key.toLowerCase().includes(query) ||
      rule.label.toLowerCase().includes(query) ||
      rule.adjudicationRefs.some((ref) => ref.toLowerCase().includes(query))
    );
  });
}

/** The change form's draft — every input is a string until submit turns it
 *  into the typed value; per-type draft shapes because a number field and a
 *  line-per-item list cannot share one string honestly. */
export interface ValueDraft {
  numberValue: string;
  textValue: string;
  booleanValue: "on" | "off";
  listText: string;
  jsonText: string;
  /** The deliberate "clear back to pending fill-in" escape hatch — switches
   *  have no such path (the kernel rejects null for them). */
  clearToPending: boolean;
}

export function emptyValueDraft(booleanOn: boolean): ValueDraft {
  return {
    numberValue: "",
    textValue: "",
    booleanValue: booleanOn ? "on" : "off",
    listText: "",
    jsonText: "",
    clearToPending: false,
  };
}

export function formatValueDraft(valueType: RuleValueType, value: unknown): ValueDraft {
  const draft = emptyValueDraft(value === true);
  if (value === null || value === undefined) return draft;
  switch (valueType) {
    case "number":
      draft.numberValue = typeof value === "number" ? String(value) : "";
      return draft;
    case "text":
      draft.textValue = typeof value === "string" ? value : "";
      return draft;
    case "string_list":
    case "number_list":
      draft.listText = Array.isArray(value) ? value.map((item) => String(item)).join("\n") : "";
      return draft;
    case "json":
    case "decision_table":
      draft.jsonText = JSON.stringify(value, null, 2);
      return draft;
    case "boolean":
      return draft;
  }
}

/** Turns the draft into the PATCH body's value, or a reason it refused.
 *  Client-side checks keep obviously-broken submits off the wire; the server
 *  remains the only authority (its zod and compile probe re-judge everything). */
export function buildRuleValue(
  valueType: RuleValueType,
  draft: ValueDraft,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (draft.clearToPending) {
    if (valueType === "boolean") {
      return { ok: false, error: "A switch is either on or off — it cannot go back to pending fill-in." };
    }
    return { ok: true, value: null };
  }
  switch (valueType) {
    case "number": {
      const parsed = Number(draft.numberValue);
      if (draft.numberValue.trim() === "" || !Number.isFinite(parsed)) {
        return { ok: false, error: "The value must be a number." };
      }
      return { ok: true, value: parsed };
    }
    case "text": {
      const text = draft.textValue.trim();
      if (text === "") return { ok: false, error: "The value must not be empty." };
      return { ok: true, value: text };
    }
    case "boolean":
      return { ok: true, value: draft.booleanValue === "on" };
    case "string_list": {
      const items = draft.listText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      if (items.length === 0) return { ok: false, error: "Enter at least one list item — one per line." };
      return { ok: true, value: items };
    }
    case "number_list": {
      const items = draft.listText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      if (items.length === 0) return { ok: false, error: "Enter at least one number — one per line." };
      const numbers = items.map((item) => Number(item));
      if (numbers.some((n) => !Number.isFinite(n))) {
        return { ok: false, error: "Every line must be a number." };
      }
      return { ok: true, value: numbers };
    }
    case "json":
    case "decision_table": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(draft.jsonText) as unknown;
      } catch {
        return { ok: false, error: "The value must be valid JSON." };
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: "The value must be a JSON object." };
      }
      return { ok: true, value: parsed };
    }
  }
}

/** The rationale refs textarea is one ref per line; the server wants 1–20
 *  non-empty strings and is the authority on length limits. */
export function parseRefs(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}
