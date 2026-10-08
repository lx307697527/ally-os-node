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
 *  order (inputs then outputs), rows in stored order: with the first hit
 *  policy the row order IS the routing order, so display never re-sorts it.
 *  `null` when the value is not shaped like a table at all; the page then
 *  shows raw JSON. */
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
  // The server's shape is an ARRAY of row maps, each carrying its own `_id`
  // (decisionTableValueSchema) — regression-pinned after the parser was found
  // reading an object-keyed shape the server never writes (every real value
  // fell back to raw JSON, grid never drew).
  if (!Array.isArray(table.rules)) return null;
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
  for (const [index, raw] of table.rules.entries()) {
    if (typeof raw !== "object" || raw === null) return null;
    const rawCells = raw as Record<string, unknown>;
    const cells: Record<string, string> = {};
    let rowId = "";
    for (const [cellKey, cell] of Object.entries(rawCells)) {
      if (typeof cell !== "string") return null;
      if (cellKey === "_id") {
        rowId = cell;
        continue;
      }
      cells[cellKey] = cell;
    }
    rows.push({ id: rowId !== "" ? rowId : `row_${index + 1}`, cells });
  }
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

// ---------------------------------------------------------------------------
// Decision-table editor draft (#233 JDM grid editor) — pure, unit-testable
// without a DOM. The grid edits a TableDraft whose columns and rows carry
// STABLE generated handles: cells are keyed by the handle, never by the
// editable column id, so renaming an id mid-keystroke cannot re-key cells
// under the editor. serialize maps handles back to ids and mirrors the
// server's shape checks (unique ids, ≥1 output, the 20/20/500 limits) so an
// obviously-broken submit never leaves the page — the server's zod + compile
// probe stay the only authority, exactly like the raw-JSON path.
// ---------------------------------------------------------------------------

export type TableColumnKind = "input" | "output";

export interface TableColumnDraft {
  /** Stable handle that cells are keyed by — generated once, never edited. */
  key: string;
  /** The GoRules column id the value carries (what row cells key on). */
  id: string;
  /** The fact path (inputs) / result key (outputs). */
  field: string;
  /** Optional human label; empty string = omitted on serialize. */
  name: string;
  kind: TableColumnKind;
}

export interface TableRowDraft {
  /** Stable handle for the editor's lists. */
  key: string;
  /** The row's `_id` in the value; empty/duplicate ids are regenerated on
   *  serialize so a save never writes a shape the server would refuse. */
  id: string;
  /** Cell expressions keyed by column handle — unknown-column cells from a
   *  corrupt stored value keep their raw key here and are surfaced (then
   *  dropped, with a named issue) at serialize instead of vanishing. */
  cells: Record<string, string>;
}

export interface TableDraft {
  hitPolicy: "first" | "collect";
  columns: TableColumnDraft[];
  rows: TableRowDraft[];
}

/** A fresh one-column draft for a rule that has no value yet — one output
 *  column (a table with nothing to produce is refused), zero rows (an empty
 *  table is legal and answers every match with fail-closed). */
export function emptyTableDraft(): TableDraft {
  return {
    hitPolicy: "first",
    columns: [{ key: "col-1", id: "output", field: "output", name: "", kind: "output" }],
    rows: [],
  };
}

/** Liberal parse of a stored value into an editable draft; `null` when the
 *  value is not shaped like a table at all and the page must fall back to raw
 *  JSON. Order matters (first-hit rows are order-sensitive), so rows keep the
 *  value's array order — unlike the display parser, which sorts for reading. */
export function formatTableDraft(value: unknown): TableDraft | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const table = value as {
    hitPolicy?: unknown;
    inputs?: unknown;
    outputs?: unknown;
    rules?: unknown;
  };
  if (table.hitPolicy !== "first" && table.hitPolicy !== "collect") return null;
  if (!Array.isArray(table.inputs) || !Array.isArray(table.outputs) || !Array.isArray(table.rules)) {
    return null;
  }
  // a table with no output column is a shape the server never accepts
  if (table.outputs.length === 0) return null;
  const columns: TableColumnDraft[] = [];
  const keyByColumnId = new Map<string, string>();
  const readColumns = (raw: unknown[], kind: TableColumnKind): boolean => {
    for (const item of raw) {
      if (typeof item !== "object" || item === null) return false;
      const column = item as { id?: unknown; field?: unknown; name?: unknown };
      if (typeof column.id !== "string" || typeof column.field !== "string") return false;
      const key = `col-${columns.length + 1}`;
      columns.push({
        key,
        id: column.id,
        field: column.field,
        name: typeof column.name === "string" ? column.name : "",
        kind,
      });
      keyByColumnId.set(column.id, key);
    }
    return true;
  };
  if (!readColumns(table.inputs, "input")) return null;
  if (!readColumns(table.outputs, "output")) return null;
  const rows: TableRowDraft[] = [];
  for (const [index, item] of table.rules.entries()) {
    if (typeof item !== "object" || item === null) return null;
    const rawCells = item as Record<string, unknown>;
    const rowId = rawCells._id;
    const cells: Record<string, string> = {};
    for (const [cellKey, cell] of Object.entries(rawCells)) {
      if (typeof cell !== "string") return null;
      if (cellKey === "_id") continue; // captured as the row id above
      cells[keyByColumnId.get(cellKey) ?? cellKey] = cell;
    }
    rows.push({
      key: `row-${index + 1}`,
      id: typeof rowId === "string" ? rowId : "",
      cells,
    });
  }
  return { hitPolicy: table.hitPolicy, columns, rows };
}

/** Column ids/fields/names and the row limits, mirrored from the server's
 *  `decisionTableValueSchema` so the page refuses before the wire what the
 *  server would refuse after it (the server still re-judges everything). */
const TABLE_LIMITS = {
  columnId: 100,
  field: 200,
  name: 200,
  inputs: 20,
  outputs: 20,
  rows: 500,
} as const;

export type TableSerializeResult =
  | { ok: true; value: unknown }
  | { ok: false; issues: string[] };

/** The draft → registry value. Cells keyed by unknown handles (a removed
 *  column's leftovers, a corrupt stored value) block the save with a named
 *  issue instead of being dropped in silence — the raw-JSON mode is where a
 *  value the grid cannot represent survives. */
export function serializeTableDraft(draft: TableDraft): TableSerializeResult {
  const issues: string[] = [];
  const inputs = draft.columns.filter((column) => column.kind === "input");
  const outputs = draft.columns.filter((column) => column.kind === "output");
  if (outputs.length === 0) {
    issues.push("Add at least one output column — a table with nothing to produce matches every row into an empty result.");
  }
  if (inputs.length > TABLE_LIMITS.inputs || outputs.length > TABLE_LIMITS.outputs) {
    issues.push(`At most ${TABLE_LIMITS.inputs} input and ${TABLE_LIMITS.outputs} output columns fit one table.`);
  }
  if (draft.rows.length > TABLE_LIMITS.rows) {
    issues.push(`At most ${TABLE_LIMITS.rows} rows fit one table.`);
  }
  const seenIds = new Set<string>();
  for (const column of draft.columns) {
    const kind = column.kind === "input" ? "input" : "output";
    if (column.id.trim() === "") {
      issues.push(`The ${kind} column needs a non-empty id.`);
    } else if (column.id.length > TABLE_LIMITS.columnId) {
      issues.push(`Column id "${column.id.slice(0, 24)}…" is over ${TABLE_LIMITS.columnId} characters.`);
    } else if (seenIds.has(column.id)) {
      issues.push(`Duplicate column id "${column.id}" — ids must be unique across inputs and outputs.`);
    }
    seenIds.add(column.id);
    if (column.field.trim() === "") {
      issues.push(`Column "${column.id}" needs a non-empty field.`);
    } else if (column.field.length > TABLE_LIMITS.field) {
      issues.push(`Column "${column.id}" field is over ${TABLE_LIMITS.field} characters.`);
    }
    if (column.name.length > TABLE_LIMITS.name) {
      issues.push(`Column "${column.id}" name is over ${TABLE_LIMITS.name} characters.`);
    }
  }
  const outputFields = new Set<string>();
  for (const column of outputs) {
    if (outputFields.has(column.field)) {
      issues.push(`Duplicate output field "${column.field}" — every output column writes its own result key.`);
    }
    outputFields.add(column.field);
  }
  const keyToId = new Map(draft.columns.map((column) => [column.key, column.id]));
  for (const row of draft.rows) {
    for (const cellKey of Object.keys(row.cells)) {
      if (!keyToId.has(cellKey)) {
        issues.push(`Row "${row.id || row.key}" has a cell for a column the table no longer has ("${keyToId.get(cellKey) ?? cellKey}") — switch to JSON mode to keep it.`);
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  const usedRowIds = new Set<string>();
  let rowCounter = 0;
  const nextRowId = (): string => {
    rowCounter += 1;
    let candidate = `row_${rowCounter}`;
    while (usedRowIds.has(candidate)) {
      rowCounter += 1;
      candidate = `row_${rowCounter}`;
    }
    return candidate;
  };
  const rules = draft.rows.map((row) => {
    const id = row.id.trim() !== "" && !usedRowIds.has(row.id) ? row.id : nextRowId();
    usedRowIds.add(id);
    const cells: Record<string, string> = { _id: id };
    for (const [cellKey, cell] of Object.entries(row.cells)) {
      const columnId = keyToId.get(cellKey);
      if (columnId !== undefined) cells[columnId] = cell;
    }
    return cells;
  });
  return {
    ok: true,
    value: {
      hitPolicy: draft.hitPolicy,
      inputs: inputs.map((column) => ({
        id: column.id,
        field: column.field,
        ...(column.name.trim() !== "" ? { name: column.name } : {}),
      })),
      outputs: outputs.map((column) => ({
        id: column.id,
        field: column.field,
        ...(column.name.trim() !== "" ? { name: column.name } : {}),
      })),
      rules,
    },
  };
}

function nextFreeId(taken: Set<string>, base: string): string {
  let n = 1;
  while (taken.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

/** A new column with a collision-free id; cells stay untouched (rows simply
 *  have no cell for it yet — an empty input cell is always-true). */
export function addTableColumn(draft: TableDraft, kind: TableColumnKind): TableDraft {
  const taken = new Set(draft.columns.map((column) => column.id));
  const id = nextFreeId(taken, kind === "input" ? "input" : "output");
  const key = nextFreeId(new Set(draft.columns.map((column) => column.key)), "col");
  return {
    ...draft,
    columns: [...draft.columns, { key, id, field: id, name: "", kind }],
  };
}

/** Removes a column and every cell keyed by it. Removing the last output
 *  column is a no-op — a table with nothing to produce is not a table. */
export function removeTableColumn(draft: TableDraft, key: string): TableDraft {
  const column = draft.columns.find((entry) => entry.key === key);
  if (column === undefined) return draft;
  if (column.kind === "output" && draft.columns.filter((entry) => entry.kind === "output").length === 1) {
    return draft;
  }
  return {
    ...draft,
    columns: draft.columns.filter((entry) => entry.key !== key),
    rows: draft.rows.map((row) => {
      if (!(key in row.cells)) return row;
      const cells = Object.fromEntries(
        Object.entries(row.cells).filter(([cellKey]) => cellKey !== key),
      );
      return { ...row, cells };
    }),
  };
}

export function patchTableColumn(
  draft: TableDraft,
  key: string,
  patch: Partial<Pick<TableColumnDraft, "id" | "field" | "name">>,
): TableDraft {
  return {
    ...draft,
    columns: draft.columns.map((column) => (column.key === key ? { ...column, ...patch } : column)),
  };
}

/** Reorders a row (first-hit policy makes row order the routing order). */
export function moveTableRow(draft: TableDraft, from: number, to: number): TableDraft {
  if (from === to || from < 0 || to < 0 || from >= draft.rows.length || to >= draft.rows.length) {
    return draft;
  }
  const rows = [...draft.rows];
  const [moved] = rows.splice(from, 1);
  if (moved === undefined) return draft;
  rows.splice(to, 0, moved);
  return { ...draft, rows };
}

/** Reorders a column within its own kind — an input can never cross into the
 *  outputs. `from`/`to` index the kind's slice, not the whole columns array. */
export function moveTableColumn(
  draft: TableDraft,
  kind: TableColumnKind,
  from: number,
  to: number,
): TableDraft {
  const slice = draft.columns
    .map((column, index) => ({ column, index }))
    .filter((entry) => entry.column.kind === kind);
  if (from === to || from < 0 || to < 0 || from >= slice.length || to >= slice.length) return draft;
  const moving = slice[from];
  const target = slice[to];
  if (moving === undefined || target === undefined) return draft;
  const columns = [...draft.columns];
  columns.splice(moving.index, 1);
  columns.splice(target.index, 0, moving.column);
  return { ...draft, columns };
}

export function addTableRow(draft: TableDraft): TableDraft {
  const key = nextFreeId(new Set(draft.rows.map((row) => row.key)), "row");
  return { ...draft, rows: [...draft.rows, { key, id: "", cells: {} }] };
}

export function removeTableRow(draft: TableDraft, key: string): TableDraft {
  return { ...draft, rows: draft.rows.filter((row) => row.key !== key) };
}

export function setTableCell(
  draft: TableDraft,
  rowKey: string,
  columnKey: string,
  expression: string,
): TableDraft {
  return {
    ...draft,
    rows: draft.rows.map((row) =>
      row.key === rowKey ? { ...row, cells: { ...row.cells, [columnKey]: expression } } : row,
    ),
  };
}

// ── Cell-issue locator (#233): the compile probe's per-cell refusals wear
//    their cell ────────────────────────────────────────────────────────────
// The server's write-face compile probe (apps/api/src/rules/
// decision-table-schema.ts) names every syntax-broken cell in its own words —
// `rule "<_id>" input|output cell "<column id>" does not parse: <zen json>` —
// joins them with "; " behind the "rules: invalid decision table: " envelope,
// and the PATCH route returns that whole string as issues[0]. These helpers
// are a mirror of that wording: the grid wears the refusal on the named cell
// instead of leaving it buried in the issues panel. The panel keeps the
// verbatim text; the locator only decides where it points.

export interface TableCellIssueRef {
  /** The rule row's `_id` as the server named it */
  rowId: string;
  /** The column id as the server named it */
  columnId: string;
  /** This cell's slice of the server message, verbatim (envelope stripped) */
  message: string;
}

const CELL_PARSE_PATTERN = /rule "([^"]*)" (?:input|output) cell "([^"]*)" does not parse: /g;
const DECISION_TABLE_ENVELOPE = "rules: invalid decision table: ";

export function parseTableCellIssues(issues: readonly string[]): TableCellIssueRef[] {
  const refs: TableCellIssueRef[] = [];
  for (const issue of issues) {
    const matches = [...issue.matchAll(CELL_PARSE_PATTERN)];
    for (const [index, match] of matches.entries()) {
      const start = match.index;
      const next = matches[index + 1]?.index ?? issue.length;
      refs.push({
        rowId: match[1] ?? "",
        columnId: match[2] ?? "",
        message: issue
          .slice(start, next)
          .replace(/;\s*$/, "")
          .trim()
          .replace(DECISION_TABLE_ENVELOPE, ""),
      });
    }
  }
  return refs;
}

/** Stable composite key for one grid cell — row and column handles contain no
 *  colons (nextFreeId mints `row_*`/`col_*`), so `::` cannot collide. */
export function cellIssueKey(rowKey: string, columnKey: string): string {
  return `${rowKey}::${columnKey}`;
}

export interface TableCellIssue {
  rowKey: string;
  columnKey: string;
  message: string;
}

/** Resolves the server's cell refs onto the current draft's stable handles.
 *  A ref the draft can no longer resolve (renamed id, removed row/column
 *  since the refused save) is dropped, not guessed — the issues panel still
 *  carries the verbatim text. */
export function locateTableCellIssues(
  issues: readonly string[],
  draft: TableDraft,
): TableCellIssue[] {
  const rowKeysById = new Map(
    draft.rows.filter((row) => row.id.trim() !== "").map((row) => [row.id, row.key]),
  );
  const columnKeysById = new Map(draft.columns.map((column) => [column.id, column.key]));
  const located: TableCellIssue[] = [];
  for (const ref of parseTableCellIssues(issues)) {
    const rowKey = rowKeysById.get(ref.rowId);
    const columnKey = columnKeysById.get(ref.columnId);
    if (rowKey === undefined || columnKey === undefined) continue;
    located.push({ rowKey, columnKey, message: ref.message });
  }
  return located;
}
