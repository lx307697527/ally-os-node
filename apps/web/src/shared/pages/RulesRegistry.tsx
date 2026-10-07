// The rules registry page (#233 config face) — the configuration studio's
// rules half: every business parameter, switch and gate the adjudications
// put on record, with the basis each change must cite.
//
// The page's rulings, kept visible:
//  - READING is for everyone; CHANGING is per-rule. The list is session-visible
//    company-wide business data, so the page never pretends the table itself is
//    privileged — but the change form speaks the 403's roles and the 400's
//    issues verbatim instead of a generic "no" (the one family where the
//    studio permission is not the write right).
//  - Every change cites its basis: at least one adjudication/owner-decision
//    ref, optional note, optional future effective time (scheduled changes
//    land on the row; the worker applies them when due).
//  - No create face and no drafts face: hard bottom lines live in code and
//    never appear as rows, and the registry_rule family answers drafts with
//    409 publish_unsupported — history and rollback through the #226 ledger
//    are the whole studio surface beyond the value change.
//  - Values render by type; a decision table draws as its grid (inputs then
//    outputs, rows sorted), and anything the liberal display parser cannot
//    draw falls back to raw JSON — display never plays validator.
//  - Decision tables are authored in the grid editor (drag rows and columns,
//    per-cell text) over a stable-handle draft in rules-client.ts; raw JSON
//    stays as the explicit escape hatch for values the grid cannot draw, and
//    the server's zod + compile probe remain the only authority either way.
//
// States are honest, never blank-by-accident — loading, an unreachable API,
// an empty registry, a forbidden history ledger, and every write failure mode
// all say themselves in words (see rules-client.ts for the adapter contract).
import type { ReactElement } from "react";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Heading, Input, Paragraph } from "@ally/ui";

import {
  createRulesAdapters,
  buildRuleValue,
  emptyTableDraft,
  emptyValueDraft,
  filterRules,
  formatTableDraft,
  formatValueDraft,
  parseDecisionTableDisplay,
  parseRefs,
  serializeTableDraft,
  valueSummary,
  RULE_CATEGORIES,
  type PathChange,
  type RuleCategory,
  type RuleFilters,
  type RuleValueType,
  type RuleView,
  type TableDraft,
  type ValueDraft,
} from "../lib/rules-client.ts";
import { DecisionTableEditor } from "../components/DecisionTableEditor.tsx";

const rulesAdapters = createRulesAdapters();

const CATEGORY_LABELS: Record<RuleCategory, string> = {
  param: "Parameter",
  switch: "Switch",
  gate: "Gate",
};

const VALUE_TYPE_LABELS: Record<RuleValueType, string> = {
  number: "Number",
  text: "Text",
  boolean: "On/off",
  string_list: "Text list",
  number_list: "Number list",
  json: "JSON",
  decision_table: "Decision table",
};

const SOURCE_LABELS: Record<string, string> = {
  created: "Created",
  updated: "Updated",
  rolled_back: "Rolled back",
  published: "Published",
  scheduled: "Scheduled",
};

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

function shortId(id: string | null): string {
  if (id === null) return "system";
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function jsonShort(value: unknown, limit = 60): string {
  const text = JSON.stringify(value === undefined ? null : value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** One value cell in the decision-table grid — the cell text as authored. */
function DecisionTableCell({ cell }: { cell: string }) {
  return <td className="border border-line px-2 py-1 align-top font-mono text-ui-sm">{cell}</td>;
}

/** The decision-table grid — inputs then outputs, rows sorted by id. A value
 *  the liberal parser cannot draw falls back to raw JSON: display never
 *  invents a shape the value does not have. */
function DecisionTableGrid({ value }: { value: unknown }) {
  const display = parseDecisionTableDisplay(value);
  if (display === null) {
    return (
      <pre
        className="mt-1 overflow-x-auto rounded-control border border-line bg-card p-3 font-mono text-ui-sm"
        data-testid="rules-value-json"
      >
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  return (
    <div className="mt-1" data-testid="rules-decision-table">
      <Paragraph className="font-mono text-ui-sm text-ink-soft">
        hit policy: {display.hitPolicy} · {display.rows.length} row
        {display.rows.length === 1 ? "" : "s"}
      </Paragraph>
      {display.rows.length === 0 ? (
        <Paragraph className="text-ui-sm text-ink-soft" data-testid="rules-decision-table-empty">
          Empty table — no row can ever match, so the rule fails closed until a
          row is added.
        </Paragraph>
      ) : (
        <div className="overflow-x-auto">
          <table className="border-collapse text-left text-ui-sm">
            <thead>
              <tr>
                {display.columns.map((column) => (
                  <th
                    key={column.id}
                    className="border border-line bg-card px-2 py-1 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft"
                  >
                    <span className="block">{column.name ?? column.field}</span>
                    <span className="block font-normal normal-case">
                      {column.kind === "input" ? "in" : "out"} · {column.id}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {display.rows.map((row) => (
                <tr key={row.id}>
                  {display.columns.map((column) => (
                    <DecisionTableCell key={column.id} cell={row.cells[column.id] ?? ""} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** The current value, drawn by type. */
function RuleValueDisplay({ rule }: { rule: RuleView }) {
  if (!rule.isSet) {
    return (
      <Paragraph className="text-ink-soft" data-testid="rules-value-pending">
        Pending fill-in — this rule is on record but has no value yet; the
        to-do queue keeps reminding whoever may set it.
      </Paragraph>
    );
  }
  if (rule.valueType === "boolean") {
    return (
      <Paragraph data-testid="rules-value-boolean">
        {rule.value === true ? (
          <span className="font-medium text-brand">On</span>
        ) : (
          <span className="text-ink-soft">Off</span>
        )}
      </Paragraph>
    );
  }
  if (rule.valueType === "number") {
    return (
      <Paragraph className="font-mono" data-testid="rules-value-number">
        {String(rule.value)}
      </Paragraph>
    );
  }
  if (rule.valueType === "text") {
    return <Paragraph data-testid="rules-value-text">{String(rule.value)}</Paragraph>;
  }
  if (rule.valueType === "string_list" || rule.valueType === "number_list") {
    const items = Array.isArray(rule.value) ? rule.value.map((item) => String(item)) : [];
    return (
      <ul className="list-disc pl-5" data-testid="rules-value-list">
        {items.map((item, index) => (
          <li key={index} className="font-mono text-ui-sm">
            {item}
          </li>
        ))}
      </ul>
    );
  }
  return <DecisionTableGrid value={rule.value} />;
}

/** What changed in one ledger version — paths with from → to, folded when
 *  long (the full snapshots live in the ledger; this is the orient line). */
function RevisionChanges({ changes }: { changes: PathChange[] }) {
  if (changes.length === 0) {
    return <span className="text-ink-soft">no content change</span>;
  }
  const shown = changes.slice(0, 3);
  return (
    <span className="font-mono text-ui-sm text-ink-soft" data-testid="rules-revision-changes">
      {shown.map((change) => (
        <span key={change.path} className="block">
          {change.path}: {jsonShort(change.from)} → {jsonShort(change.to)}
        </span>
      ))}
      {changes.length > shown.length ? (
        <span className="block">+{changes.length - shown.length} more field(s)</span>
      ) : null}
    </span>
  );
}

export function RulesRegistry(): ReactElement {
  const queryClient = useQueryClient();

  const [filters, setFilters] = useState<RuleFilters>({ query: "", category: "all", pendingOnly: false });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [changeOpen, setChangeOpen] = useState(false);
  const [draft, setDraft] = useState<ValueDraft>(emptyValueDraft(false));
  /** Decision-table authoring face (#233 JDM editor): the grid draft, and
   *  which face is live — the grid for any value that draws as a table, raw
   *  JSON as the explicit fallback and escape hatch. */
  const [tableDraft, setTableDraft] = useState<TableDraft | null>(null);
  const [editorMode, setEditorMode] = useState<"grid" | "json">("grid");
  const [refsText, setRefsText] = useState("");
  const [noteText, setNoteText] = useState("");
  const [effectiveAt, setEffectiveAt] = useState("");
  const [changeError, setChangeError] = useState<string | null>(null);
  const [changeIssues, setChangeIssues] = useState<string[] | null>(null);
  const [changeBusy, setChangeBusy] = useState(false);
  const [rollbackVersion, setRollbackVersion] = useState("");
  const [rollbackReason, setRollbackReason] = useState("");
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const rulesQuery = useQuery({
    queryKey: ["rules-registry"],
    queryFn: () => rulesAdapters.list(),
  });
  const rules = rulesQuery.data?.ok ? rulesQuery.data.data : undefined;
  const unavailable = (rulesQuery.data?.ok === false && rulesQuery.data.reason === "unavailable") || rules === undefined;

  const filtered = rules !== undefined ? filterRules(rules, filters) : [];
  const selected = rules?.find((rule) => rule.key === selectedKey) ?? null;
  const selectedId = selected?.id ?? null;

  const historyQuery = useQuery({
    queryKey: ["rules-registry-history", selectedId],
    queryFn: () => rulesAdapters.history(selectedId ?? ""),
    enabled: selectedId !== null,
  });
  const history = historyQuery.data?.ok ? historyQuery.data.data : undefined;

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ["rules-registry"] });
    void queryClient.invalidateQueries({ queryKey: ["rules-registry-history"] });
  }

  function openDetail(rule: RuleView): void {
    setFlash(null);
    setSelectedKey(rule.key);
    setChangeOpen(false);
    setChangeError(null);
    setChangeIssues(null);
    setRollbackError(null);
  }

  function openChange(rule: RuleView): void {
    setFlash(null);
    setChangeOpen(true);
    setChangeError(null);
    setChangeIssues(null);
    setDraft(formatValueDraft(rule.valueType, rule.value));
    if (rule.valueType === "decision_table") {
      const grid = rule.isSet ? formatTableDraft(rule.value) : emptyTableDraft();
      setTableDraft(grid);
      setEditorMode(grid === null ? "json" : "grid");
    } else {
      setTableDraft(null);
      setEditorMode("grid");
    }
    setRefsText("");
    setNoteText("");
    setEffectiveAt("");
  }

  /** Grid → JSON: the grid's current shape serializes into the textarea, so
   *  the JSON face shows the truth the grid would save — or refuses with the
   *  same structural issues a save would hit. */
  function switchToJsonEditor(): void {
    if (tableDraft === null) {
      setEditorMode("json");
      return;
    }
    const serialized = serializeTableDraft(tableDraft);
    if (!serialized.ok) {
      setChangeError("The table cannot be saved yet:");
      setChangeIssues(serialized.issues);
      return;
    }
    setDraft({ ...draft, jsonText: JSON.stringify(serialized.value, null, 2) });
    setChangeError(null);
    setChangeIssues(null);
    setEditorMode("json");
  }

  /** JSON → grid: only values that draw as a table may cross — anything else
   *  stays in JSON mode, where it is at least visible. */
  function switchToGridEditor(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft.jsonText) as unknown;
    } catch {
      setChangeError("The JSON does not parse — fix it here or restore the value before switching to the grid.");
      return;
    }
    const grid = formatTableDraft(parsed);
    if (grid === null) {
      setChangeError("This JSON is not shaped like a decision table — the grid can only edit table-shaped values.");
      return;
    }
    setTableDraft(grid);
    setChangeError(null);
    setChangeIssues(null);
    setEditorMode("grid");
  }

  async function submitChange(): Promise<void> {
    if (selected === null || !changeOpen) return;
    const refs = parseRefs(refsText);
    if (refs.length === 0) {
      setChangeError("A change must cite its basis — at least one adjudication or owner-decision ref.");
      return;
    }
    // The grid face serializes its own draft; a table the grid cannot express
    // is refused here (named issues, no request) — the server's zod + compile
    // probe re-judge whatever leaves the page, grid or JSON alike.
    let value: unknown;
    if (selected.valueType === "decision_table" && editorMode === "grid" && !draft.clearToPending) {
      if (tableDraft === null) {
        setChangeError("The grid lost its draft — switch to JSON mode or reopen the change form.");
        return;
      }
      const serialized = serializeTableDraft(tableDraft);
      if (!serialized.ok) {
        setChangeError("The table cannot be saved yet:");
        setChangeIssues(serialized.issues);
        return;
      }
      value = serialized.value;
    } else {
      const built = buildRuleValue(selected.valueType, draft);
      if (!built.ok) {
        setChangeError(built.error);
        return;
      }
      value = built.value;
    }
    let effectiveAtIso: string | undefined;
    if (effectiveAt !== "") {
      const moment = new Date(effectiveAt);
      if (Number.isNaN(moment.getTime())) {
        setChangeError("The effective time could not be read — pick it again.");
        return;
      }
      if (moment.getTime() <= Date.now()) {
        setChangeError("The effective time must be in the future — leave it empty to apply now.");
        return;
      }
      effectiveAtIso = moment.toISOString();
    }
    setChangeBusy(true);
    setChangeError(null);
    setChangeIssues(null);
    const result = await rulesAdapters.change(selected.key, {
      value,
      rationale: noteText.trim() === "" ? { refs } : { refs, note: noteText.trim() },
      ...(effectiveAtIso !== undefined ? { effectiveAt: effectiveAtIso } : {}),
    });
    setChangeBusy(false);
    if (!result.ok) {
      if (result.reason === "forbidden") {
        setChangeError(
          `The server refused the change — only ${result.roles.join(", ")} (or the owner) may change this rule.`,
        );
      } else if (result.reason === "invalid") {
        setChangeError("The value was rejected:");
        setChangeIssues(result.issues.length > 0 ? result.issues : ["The value does not fit this rule's type."]);
      } else if (result.reason === "invalid_effective_time") {
        setChangeError("The effective time must be in the future — leave it empty to apply now.");
      } else if (result.reason === "not_found") {
        setChangeError("This rule no longer exists — hard bottom lines and removed rules answer 404.");
      } else {
        setChangeError("The change could not be saved. Reload and try again.");
      }
      return;
    }
    setChangeOpen(false);
    setFlash(
      result.data.mode === "scheduled" && result.data.effectiveAt !== undefined
        ? `Scheduled — the worker will apply it ${formatDateTime(result.data.effectiveAt)}. Basis on record.`
        : `Saved — version ${result.data.version ?? selected.version} is live now. Basis on record.`,
    );
    refresh();
  }

  async function submitRollback(): Promise<void> {
    if (selected === null || rollbackVersion === "") return;
    setRollbackBusy(true);
    setRollbackError(null);
    const reason = rollbackReason.trim();
    const result = await rulesAdapters.rollback(
      selected.id,
      Number(rollbackVersion),
      reason === "" ? undefined : reason,
    );
    setRollbackBusy(false);
    if (!result.ok) {
      if (result.reason === "forbidden") {
        setRollbackError("The server refused the rollback — the ledger gate (rules.configure) and this rule's write roles both apply.");
      } else if (result.reason === "no_change") {
        setRollbackError("That version is already the live one — nothing to roll back.");
      } else if (result.reason === "not_found") {
        setRollbackError("That version is not in the ledger — someone else may have rolled back meanwhile.");
      } else if (result.reason === "unsupported") {
        setRollbackError("This rule's family does not support rollback.");
      } else {
        setRollbackError("The rollback could not be saved. Reload and try again.");
      }
      return;
    }
    setFlash(`Rolled back to v${result.data.restoredVersion} — recorded as v${result.data.newVersion}, audit on record.`);
    setRollbackVersion("");
    setRollbackReason("");
    refresh();
  }

  const rollbackChoices = (history ?? []).filter(
    (revision) => selected !== null && revision.version !== selected.version,
  );

  return (
    <div className="w-full" data-page="rules-registry" data-testid="rules-root">
      <Card>
        <Heading as="h2">Rules registry</Heading>
        <Paragraph className="text-ink-soft">
          The company's business parameters, switches and gates, each on record
          with its adjudication basis. Every change cites its basis; a switch
          turned on passes its enable-by confirmation; hard bottom lines live in
          code — they never appear here and no rule can be created from this page.
        </Paragraph>

        {flash !== null ? (
          <Paragraph className="mt-3 text-ink" data-testid="rules-flash">
            {flash}
          </Paragraph>
        ) : null}

        {rulesQuery.isPending ? (
          <Paragraph className="mt-3" data-testid="rules-loading">
            Loading…
          </Paragraph>
        ) : unavailable ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="rules-unavailable">
            The rules registry could not be loaded.
          </Paragraph>
        ) : rules.length === 0 ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="rules-empty">
            The registry holds no rules yet — rules arrive with their
            adjudications, not from this page.
          </Paragraph>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap items-end gap-3" data-testid="rules-filters">
              <label className="text-ui-sm text-ink">
                Find
                <Input
                  className="mt-1 block w-64"
                  data-testid="rules-filter-query"
                  value={filters.query}
                  placeholder="key, label or basis ref…"
                  onChange={(e) => {
                    setFilters({ ...filters, query: e.target.value });
                  }}
                />
              </label>
              <label className="text-ui-sm text-ink">
                Kind
                <select
                  className="mt-1 block rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink"
                  data-testid="rules-filter-category"
                  value={filters.category}
                  onChange={(e) => {
                    setFilters({ ...filters, category: e.target.value as RuleFilters["category"] });
                  }}
                >
                  <option value="all">All kinds</option>
                  {RULE_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {CATEGORY_LABELS[category]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex cursor-pointer items-center gap-2 pb-1 text-ui-sm text-ink">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--accent)]"
                  data-testid="rules-filter-pending"
                  checked={filters.pendingOnly}
                  onChange={(e) => {
                    setFilters({ ...filters, pendingOnly: e.target.checked });
                  }}
                />
                Pending fill-in only
              </label>
            </div>

            <div className="mt-3 overflow-x-auto" data-testid="rules-table">
              <table className="w-full border-collapse text-left text-ui-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">Rule</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">Value</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">Runs</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">Ver</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">Updated</th>
                    <th className="py-2 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft"> </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((rule) => (
                    <tr key={rule.id} className="border-b border-line align-top" data-testid="rules-row">
                      <td className="py-2 pr-4">
                        <span className="font-mono">{rule.key}</span>
                        <span className="block text-ink-soft">{rule.label}</span>
                        <span className="mt-0.5 block font-mono text-[length:var(--fs-meta)] uppercase tracking-[var(--ls-crumb)] text-ink-soft">
                          {CATEGORY_LABELS[rule.category]} · {VALUE_TYPE_LABELS[rule.valueType]}
                          {rule.riskFlag ? (
                            <span
                              className="ml-2 font-medium text-err normal-case"
                              title={rule.riskNote ?? "Flagged risky"}
                              data-testid="rules-risk"
                            >
                              ⚠ risky
                            </span>
                          ) : null}
                          {rule.scheduled !== null ? (
                            <span className="ml-2 normal-case" data-testid="rules-row-scheduled">
                              ⏱ scheduled
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td className="py-2 pr-4">
                        <span data-testid="rules-row-value">{valueSummary(rule.valueType, rule.value)}</span>
                      </td>
                      <td className="py-2 pr-4 font-mono text-ink-soft" title="triggers / exceptions / overrides">
                        {rule.counts.triggers}/{rule.counts.exceptions}/{rule.counts.overrides}
                      </td>
                      <td className="py-2 pr-4 font-mono text-ink-soft">v{rule.version}</td>
                      <td className="py-2 pr-4 whitespace-nowrap text-ink-soft">{formatDateTime(rule.updatedAt)}</td>
                      <td className="py-2">
                        <Button
                          variant="default"
                          size="sm"
                          data-testid="rules-row-open"
                          onClick={() => {
                            openDetail(rule);
                          }}
                        >
                          Open
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-3 text-ink-soft" data-testid="rules-filter-empty">
                        No rule matches these filters.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            {selected !== null ? (
              <div className="mt-4 rounded-card border border-line p-4" data-testid="rules-detail">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Heading as="h3">
                    {selected.label} <span className="font-mono text-ui-sm text-ink-soft">{selected.key}</span>
                  </Heading>
                  <span className="font-mono text-[length:var(--fs-meta)] uppercase tracking-[var(--ls-crumb)] text-ink-soft">
                    {CATEGORY_LABELS[selected.category]} · {VALUE_TYPE_LABELS[selected.valueType]} · v{selected.version}
                  </span>
                </div>
                {selected.riskFlag ? (
                  <Paragraph className="mt-2 text-err" data-testid="rules-detail-risk">
                    ⚠ Flagged risky{selected.riskNote !== null ? ` — ${selected.riskNote}` : ""}.
                  </Paragraph>
                ) : null}
                <Paragraph className="mt-2 text-ui-sm text-ink-soft">
                  May be changed by: <span className="font-mono">{selected.changeableBy.join(", ") || "—"} , always the owner</span>
                  {" · "}Enable confirmed by:{" "}
                  <span className="font-mono">{selected.enableBy === null ? "owner only" : selected.enableBy.join(", ")}</span>
                </Paragraph>
                <Paragraph className="mt-1 text-ui-sm text-ink-soft">
                  Basis: {selected.adjudicationRefs.length > 0 ? selected.adjudicationRefs.join(" · ") : "—"}
                </Paragraph>

                <div className="mt-3" data-testid="rules-detail-value">
                  <RuleValueDisplay rule={selected} />
                </div>

                {selected.scheduled !== null ? (
                  <div className="mt-3 rounded-control border border-line bg-card p-3" data-testid="rules-scheduled">
                    <Paragraph className="text-ui-sm">
                      ⏱ Scheduled change takes effect {formatDateTime(selected.scheduled.effectiveAt)} —{" "}
                      {valueSummary(selected.valueType, selected.scheduled.value)}. Basis:{" "}
                      {selected.scheduled.rationale.refs.join(" · ")}
                      {selected.scheduled.rationale.note !== undefined ? ` — ${selected.scheduled.rationale.note}` : ""}. The
                      worker applies it when due; until then the current value stays live.
                    </Paragraph>
                  </div>
                ) : null}

                {changeOpen ? (
                  <div className="mt-3 rounded-card border border-line p-4" data-testid="rules-change-form">
                    <Heading as="h3">Change value</Heading>
                    <Paragraph className="mt-1 text-ui-sm text-ink-soft">
                      {selected.valueType === "boolean"
                        ? `A switch is on or off. Turning it on needs the enable-by confirmation (${selected.enableBy === null ? "owner only" : selected.enableBy.join(", ")}; owner always).`
                        : "Parameters apply to business events from now on — documents already issued keep the value they were made under."}
                    </Paragraph>
                    <div className="mt-3 grid gap-3">
                      {selected.valueType === "number" ? (
                        <label className="text-ui-sm text-ink">
                          Value
                          <Input
                            className="mt-1 block w-48"
                            type="number"
                            data-testid="rules-edit-number"
                            value={draft.numberValue}
                            onChange={(e) => {
                              setDraft({ ...draft, numberValue: e.target.value, clearToPending: false });
                            }}
                          />
                        </label>
                      ) : null}
                      {selected.valueType === "text" ? (
                        <label className="text-ui-sm text-ink">
                          Value
                          <Input
                            className="mt-1 block w-full"
                            data-testid="rules-edit-text"
                            value={draft.textValue}
                            onChange={(e) => {
                              setDraft({ ...draft, textValue: e.target.value, clearToPending: false });
                            }}
                          />
                        </label>
                      ) : null}
                      {selected.valueType === "boolean" ? (
                        <label className="text-ui-sm text-ink">
                          Switch
                          <select
                            className="mt-1 block rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink"
                            data-testid="rules-edit-boolean"
                            value={draft.booleanValue}
                            onChange={(e) => {
                              setDraft({ ...draft, booleanValue: e.target.value as ValueDraft["booleanValue"] });
                            }}
                          >
                            <option value="off">Off</option>
                            <option value="on">On</option>
                          </select>
                        </label>
                      ) : null}
                      {selected.valueType === "string_list" || selected.valueType === "number_list" ? (
                        <label className="text-ui-sm text-ink">
                          {selected.valueType === "number_list" ? "Numbers — one per line" : "Items — one per line"}
                          <textarea
                            className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] font-mono text-ui text-ink"
                            rows={4}
                            data-testid="rules-edit-list"
                            value={draft.listText}
                            onChange={(e) => {
                              setDraft({ ...draft, listText: e.target.value, clearToPending: false });
                            }}
                          />
                        </label>
                      ) : null}
                      {selected.valueType === "decision_table" ? (
                        <div data-testid="rules-edit-table-face">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-ui-sm text-ink">Edit as</span>
                            <Button
                              variant={editorMode === "grid" ? "primary" : "default"}
                              size="sm"
                              data-testid="rules-edit-mode-grid"
                              onClick={switchToGridEditor}
                            >
                              Grid
                            </Button>
                            <Button
                              variant={editorMode === "json" ? "primary" : "default"}
                              size="sm"
                              data-testid="rules-edit-mode-json"
                              onClick={switchToJsonEditor}
                            >
                              JSON
                            </Button>
                            <Paragraph className="text-ui-sm text-ink-soft">
                              The grid edits the table directly; JSON is the
                              escape hatch for values the grid cannot draw. The
                              server compiles every cell either way — the
                              preview here never decides.
                            </Paragraph>
                          </div>
                          {editorMode === "grid" && tableDraft !== null ? (
                            <div className="mt-3">
                              <DecisionTableEditor draft={tableDraft} onChange={setTableDraft} />
                            </div>
                          ) : (
                            <>
                              <label className="mt-3 block text-ui-sm text-ink">
                                Decision table (GoRules ZEN JSON) — the server
                                compiles every cell; a table that does not parse
                                is refused with the exact cell errors
                                <textarea
                                  className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] font-mono text-ui text-ink"
                                  rows={10}
                                  data-testid="rules-edit-json"
                                  value={draft.jsonText}
                                  onChange={(e) => {
                                    setDraft({ ...draft, jsonText: e.target.value, clearToPending: false });
                                  }}
                                />
                              </label>
                              {draft.jsonText.trim() !== "" ? (
                                <div className="mt-2">
                                  <Paragraph className="text-ui-sm text-ink-soft">
                                    Preview (display only — the server decides):
                                  </Paragraph>
                                  <DecisionTableGrid
                                    value={(() => {
                                      try {
                                        return JSON.parse(draft.jsonText) as unknown;
                                      } catch {
                                        return null;
                                      }
                                    })()}
                                  />
                                </div>
                              ) : null}
                            </>
                          )}
                        </div>
                      ) : selected.valueType === "json" ? (
                        <label className="text-ui-sm text-ink">
                          Value (JSON)
                          <textarea
                            className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] font-mono text-ui text-ink"
                            rows={10}
                            data-testid="rules-edit-json"
                            value={draft.jsonText}
                            onChange={(e) => {
                              setDraft({ ...draft, jsonText: e.target.value, clearToPending: false });
                            }}
                          />
                        </label>
                      ) : null}
                      {selected.category !== "switch" && selected.isSet ? (
                        <label className="flex cursor-pointer items-center gap-2 text-ui-sm text-ink">
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--accent)]"
                            data-testid="rules-edit-clear"
                            checked={draft.clearToPending}
                            onChange={(e) => {
                              setDraft({ ...draft, clearToPending: e.target.checked });
                            }}
                          />
                          Clear the value back to pending fill-in
                        </label>
                      ) : null}
                      <label className="text-ui-sm text-ink">
                        Basis refs — one per line, at least one (adjudication number or owner decision)
                        <textarea
                          className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] font-mono text-ui text-ink"
                          rows={2}
                          data-testid="rules-edit-refs"
                          value={refsText}
                          onChange={(e) => {
                            setRefsText(e.target.value);
                          }}
                        />
                      </label>
                      <label className="text-ui-sm text-ink">
                        Note (optional)
                        <Input
                          className="mt-1 block w-full"
                          data-testid="rules-edit-note"
                          value={noteText}
                          onChange={(e) => {
                            setNoteText(e.target.value);
                          }}
                        />
                      </label>
                      <label className="text-ui-sm text-ink">
                        Effective at (optional — empty applies now)
                        <Input
                          className="mt-1 block w-64"
                          type="datetime-local"
                          data-testid="rules-edit-effective-at"
                          value={effectiveAt}
                          onChange={(e) => {
                            setEffectiveAt(e.target.value);
                          }}
                        />
                      </label>
                    </div>
                    {changeError !== null ? (
                      <Paragraph className="mt-2 text-err font-medium" data-testid="rules-change-error">
                        {changeError}
                      </Paragraph>
                    ) : null}
                    {changeIssues !== null ? (
                      <ul className="mt-1 list-disc pl-5 font-mono text-ui-sm text-err" data-testid="rules-change-issues">
                        {changeIssues.map((issue, index) => (
                          <li key={index}>{issue}</li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="mt-3 flex gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={changeBusy}
                        data-testid="rules-change-submit"
                        onClick={() => {
                          void submitChange();
                        }}
                      >
                        {changeBusy ? "Saving…" : "Save change"}
                      </Button>
                      <Button
                        variant="default"
                        size="sm"
                        disabled={changeBusy}
                        data-testid="rules-change-cancel"
                        onClick={() => {
                          setChangeOpen(false);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3">
                    <Button
                      variant="primary"
                      size="sm"
                      data-testid="rules-detail-change"
                      onClick={() => {
                        openChange(selected);
                      }}
                    >
                      Change value
                    </Button>
                  </div>
                )}

                <div className="mt-4 border-t border-line pt-3" data-testid="rules-history">
                  <Heading as="h3">Version history</Heading>
                  {historyQuery.isPending || (historyQuery.fetchStatus === "idle" && history === undefined) ? (
                    <Paragraph className="mt-1 text-ink-soft" data-testid="rules-history-loading">
                      Loading history…
                    </Paragraph>
                  ) : historyQuery.data?.ok === false && historyQuery.data.reason === "forbidden" ? (
                    <Paragraph className="mt-1 text-ink-soft" data-testid="rules-history-forbidden">
                      The version ledger is part of the configuration studio and
                      needs the rules permission — ask an administrator for the
                      history and one-click rollback.
                    </Paragraph>
                  ) : history === undefined ? (
                    <Paragraph className="mt-1 text-ink-soft" data-testid="rules-history-unavailable">
                      The version history could not be loaded.
                    </Paragraph>
                  ) : (
                    <>
                      <table className="mt-2 w-full border-collapse text-left text-ui-sm">
                        <thead>
                          <tr className="border-b border-line">
                            <th className="py-1 pr-4 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">Ver</th>
                            <th className="py-1 pr-4 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">Source</th>
                            <th className="py-1 pr-4 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">By</th>
                            <th className="py-1 pr-4 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">When</th>
                            <th className="py-1 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">Changed</th>
                          </tr>
                        </thead>
                        <tbody>
                          {history.map((revision) => (
                            <tr key={revision.version} className="border-b border-line align-top" data-testid="rules-revision-row">
                              <td className="py-1 pr-4 font-mono">v{revision.version}</td>
                              <td className="py-1 pr-4">{SOURCE_LABELS[revision.source] ?? revision.source}</td>
                              <td className="py-1 pr-4 font-mono text-ink-soft">{shortId(revision.changedById)}</td>
                              <td className="py-1 pr-4 whitespace-nowrap text-ink-soft">{formatDateTime(revision.createdAt)}</td>
                              <td className="py-1">
                                <RevisionChanges changes={revision.changes} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {rollbackChoices.length > 0 ? (
                        <div className="mt-3 rounded-control border border-line p-3" data-testid="rules-rollback-form">
                          <Paragraph className="text-ui-sm text-ink-soft">
                            One-click rollback — the restored version is recorded
                            as a new version; history is never rewritten, and the
                            rollback itself is audited. A rollback also clears
                            any pending scheduled change.
                          </Paragraph>
                          <div className="mt-2 flex flex-wrap items-end gap-3">
                            <label className="text-ui-sm text-ink">
                              Restore to
                              <select
                                className="mt-1 block rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink"
                                data-testid="rules-rollback-select"
                                value={rollbackVersion}
                                onChange={(e) => {
                                  setRollbackVersion(e.target.value);
                                }}
                              >
                                <option value="">Pick a version…</option>
                                {rollbackChoices.map((revision) => (
                                  <option key={revision.version} value={String(revision.version)}>
                                    v{revision.version} — {SOURCE_LABELS[revision.source] ?? revision.source} —{" "}
                                    {formatDateTime(revision.createdAt)}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="text-ui-sm text-ink">
                              Reason (optional)
                              <Input
                                className="mt-1 block w-64"
                                data-testid="rules-rollback-reason"
                                value={rollbackReason}
                                onChange={(e) => {
                                  setRollbackReason(e.target.value);
                                }}
                              />
                            </label>
                            <Button
                              variant="primary"
                              size="sm"
                              disabled={rollbackBusy || rollbackVersion === ""}
                              data-testid="rules-rollback-submit"
                              onClick={() => {
                                void submitRollback();
                              }}
                            >
                              {rollbackBusy ? "Rolling back…" : "Roll back"}
                            </Button>
                          </div>
                          {rollbackError !== null ? (
                            <Paragraph className="mt-2 text-err font-medium" data-testid="rules-rollback-error">
                              {rollbackError}
                            </Paragraph>
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}
