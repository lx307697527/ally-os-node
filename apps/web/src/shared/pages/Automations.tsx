// The automation rules page (#224 config face) — the configuration studio's
// automations half: trigger → conditions → actions rules saved as data, the
// run log that proves what they did, and the #226 ledger behind every change.
//
// The page's rulings, kept visible:
//  - Saving goes live immediately. The worker's scanners read enabled rules
//    every cycle — there is no publish step and no drafts face here; a rule
//    is one write away from changing the company's chain reactions, which is
//    exactly why the whole page sits behind `automations.configure`.
//  - Every execution is on the record. The run log draws each condition's
//    verdict and each action's outcome; deleted rules leave their runs behind
//    (the log outlives the config), and the delete copy says so.
//  - The spec is an open set. Trigger and action shapes this build has no
//    editor for stay raw JSON through the edit round trip — display summaries
//    name them honestly ("not drawn by this build"), and saving an old rule
//    can never silently destroy the part the operator could not see.
//  - The server is the only authority. Client checks keep obviously-broken
//    submits off the wire; the kernel re-judges everything, including the
//    due trigger's registered-anchor rule: an unregistered pair saves fine
//    and never fires, and the form says that instead of pretending.
//
// States are honest, never blank-by-accident — loading, forbidden, an
// unreachable API, an empty registry, and every write failure mode all say
// themselves in words (see automations-client.ts for the adapter contract).
import type { ReactElement } from "react";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Heading, Input, Paragraph } from "@ally/ui";

import {
  AUTOMATION_RUN_STATUSES,
  CONDITION_OPS,
  actionsSummary,
  buildDescription,
  buildSpec,
  conditionsSummary,
  createAutomationsAdapters,
  emptyActionDraft,
  emptyConditionDraft,
  emptySpecDraft,
  filterRules,
  parseActionResult,
  parseConditionOutcome,
  specToDraft,
  triggerSummary,
  type ActionDraft,
  type AutomationRunRow,
  type AutomationRuleRow,
  type AutomationsFilters,
  type ConditionDraft,
  type ConditionOutcomeView,
  type PathChange,
  type SpecDraft,
  type TriggerDraft,
} from "../lib/automations-client.ts";

const automationsAdapters = createAutomationsAdapters();

const RUN_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  skipped: "Skipped",
  succeeded: "Succeeded",
  failed: "Failed",
};

const SOURCE_LABELS: Record<string, string> = {
  created: "Created",
  updated: "Updated",
  rolled_back: "Rolled back",
  published: "Published",
  scheduled: "Scheduled",
};

// The audit actions the trigger's event editor suggests. Suggestions, not
// constraints — the server accepts any action string, because every domain
// writes audit events (#29) and each one is a potential trigger.
const COMMON_AUDIT_ACTIONS = [
  "task.created",
  "task.updated",
  "task.assigned",
  "task.status_changed",
  "comment.created",
  "workflow.instance_started",
  "workflow.state_changed",
  "approval.requested",
  "approval.completed",
  "approval.rejected",
  "esignature.created",
  "custom_fields.values_updated",
  "follow.created",
];

const OP_LABELS: Record<string, string> = {
  eq: "equals",
  ne: "not equals",
  in: "one of",
  exists: "exists",
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

/** One drawn action of a spec — create_task and notify render their config;
 *  anything else (a type this build has no editor for) falls back to raw
 *  JSON: display never invents a shape the value does not have. */
function ActionCard({ action }: { action: unknown }) {
  const record =
    typeof action === "object" && action !== null && !Array.isArray(action)
      ? (action as Record<string, unknown>)
      : null;
  if (record === null || typeof record.type !== "string") {
    return (
      <pre
        className="overflow-x-auto rounded-control border border-line bg-card p-3 font-mono text-ui-sm"
        data-testid="automations-action-json-raw"
      >
        {JSON.stringify(action, null, 2)}
      </pre>
    );
  }
  const config =
    typeof record.config === "object" && record.config !== null
      ? (record.config as Record<string, unknown>)
      : {};
  if (record.type === "create_task") {
    const title = typeof config.title === "string" ? config.title : "";
    return (
      <div className="rounded-control border border-line p-3" data-testid="automations-action-create-task">
        <Paragraph className="font-medium">Create task — {title}</Paragraph>
        <Paragraph className="mt-1 text-ui-sm text-ink-soft">
          {[
            typeof config.description === "string" ? config.description : null,
            typeof config.assigneeId === "string" ? `assignee ${shortId(config.assigneeId)}` : null,
            typeof config.dueInHours === "number" ? `due in ${config.dueInHours}h` : null,
          ]
            .filter((part) => part !== null)
            .join(" · ") || "No description, default assignee, no due date."}
        </Paragraph>
      </div>
    );
  }
  if (record.type === "notify") {
    const recipients = Array.isArray(config.userIds) ? config.userIds.length : 0;
    const title = typeof config.title === "string" ? config.title : "";
    return (
      <div className="rounded-control border border-line p-3" data-testid="automations-action-notify">
        <Paragraph className="font-medium">Notify — {title}</Paragraph>
        <Paragraph className="mt-1 text-ui-sm text-ink-soft">
          {recipients} recipient{recipients === 1 ? "" : "s"}
          {typeof config.body === "string" && config.body !== "" ? ` · ${config.body}` : ""}
        </Paragraph>
      </div>
    );
  }
  if (record.type === "send_email") {
    const recipients = Array.isArray(config.userIds) ? config.userIds.length : 0;
    const subject = typeof config.subject === "string" ? config.subject : "";
    return (
      <div className="rounded-control border border-line p-3" data-testid="automations-action-send-email">
        <Paragraph className="font-medium">Send email — {subject}</Paragraph>
        <Paragraph className="mt-1 text-ui-sm text-ink-soft">
          {recipients} recipient{recipients === 1 ? "" : "s"} by user id — each account's email address
          {typeof config.body === "string" && config.body !== "" ? ` · ${config.body}` : ""}
        </Paragraph>
      </div>
    );
  }
  if (record.type === "send_webhook") {
    const url = typeof config.url === "string" ? config.url : "";
    const method = typeof config.method === "string" ? config.method : "POST";
    const headerCount =
      typeof config.headers === "object" && config.headers !== null && !Array.isArray(config.headers)
        ? Object.keys(config.headers).length
        : 0;
    const hasBody = config.body !== undefined;
    return (
      <div className="rounded-control border border-line p-3" data-testid="automations-action-send-webhook">
        <Paragraph className="font-medium">
          Webhook — {method} <span className="font-mono">{url}</span>
        </Paragraph>
        <Paragraph className="mt-1 text-ui-sm text-ink-soft">
          {headerCount} header{headerCount === 1 ? "" : "s"}
          {hasBody ? " · JSON body as saved (no templating)" : " · no body"} — https public targets
          only, delivery is at-least-once.
        </Paragraph>
      </div>
    );
  }
  if (record.type === "update_field") {
    const subjectType = typeof config.subjectType === "string" ? config.subjectType : "";
    const field = typeof config.field === "string" ? config.field : "";
    return (
      <div className="rounded-control border border-line p-3" data-testid="automations-action-update-field">
        <Paragraph className="font-medium">
          Update field — <span className="font-mono">{subjectType}.{field}</span>
        </Paragraph>
        <Paragraph className="mt-1 text-ui-sm text-ink-soft">
          Set to {jsonShort(config.value)} on the trigger&apos;s own row — only registered fields
          are writable; signed records are locked.
        </Paragraph>
      </div>
    );
  }
  return (
    <div className="rounded-control border border-line p-3" data-testid="automations-action-unknown">
      <Paragraph className="text-ui-sm text-ink-soft">
        Action type <span className="font-mono">{record.type}</span> — not drawn by this build; the
        saved JSON stands:
      </Paragraph>
      <pre className="mt-1 overflow-x-auto font-mono text-ui-sm">{JSON.stringify(action, null, 2)}</pre>
    </div>
  );
}

/** The current spec, drawn for the detail panel. */
function SpecDisplay({ rule }: { rule: AutomationRuleRow }) {
  return (
    <div className="grid gap-3" data-testid="automations-detail-spec">
      <div data-testid="automations-detail-trigger">
        <Paragraph className="text-ui-sm font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">
          Trigger
        </Paragraph>
        <Paragraph className="font-mono">{triggerSummary(rule.trigger)}</Paragraph>
      </div>
      <div data-testid="automations-detail-conditions">
        <Paragraph className="text-ui-sm font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">
          Conditions
        </Paragraph>
        {rule.conditions.length === 0 ? (
          <Paragraph>No conditions — the rule fires on every trigger hit.</Paragraph>
        ) : (
          <ul className="list-disc pl-5 font-mono text-ui-sm">
            {rule.conditions.map((condition, index) => {
              const record =
                typeof condition === "object" && condition !== null
                  ? (condition as Record<string, unknown>)
                  : null;
              if (record !== null && typeof record.path === "string" && typeof record.op === "string") {
                return (
                  <li key={index}>
                    {record.path} {OP_LABELS[record.op] ?? record.op}{" "}
                    {"value" in record ? jsonShort(record.value) : ""}
                  </li>
                );
              }
              return <li key={index}>{jsonShort(condition)}</li>;
            })}
          </ul>
        )}
      </div>
      <div data-testid="automations-detail-actions">
        <Paragraph className="text-ui-sm font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">
          Actions — run in order, each in its own transaction
        </Paragraph>
        <div className="mt-1 grid gap-2">
          {rule.actions.map((action, index) => (
            <ActionCard key={index} action={action} />
          ))}
        </div>
      </div>
    </div>
  );
}

interface SpecEditorProps {
  draft: SpecDraft;
  onChange: (next: SpecDraft) => void;
  /** Testid prefix — "create" or "edit" — so the two forms' fields stay
   *  distinguishable in tests without a DOM. */
  prefix: string;
}

const CONTROL_CLASS =
  "mt-1 block rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink";

/** The trigger → conditions → actions editor. Known shapes get structured
 *  fields; unknown ones get a verbatim JSON textarea (see the file header). */
function SpecEditor({ draft, onChange, prefix }: SpecEditorProps): ReactElement {
  function setTrigger(trigger: TriggerDraft): void {
    onChange({ ...draft, trigger });
  }
  function setConditions(conditions: ConditionDraft[]): void {
    onChange({ ...draft, conditions });
  }
  function setActions(actions: ActionDraft[]): void {
    onChange({ ...draft, actions });
  }
  function updateCondition(index: number, next: ConditionDraft): void {
    setConditions(draft.conditions.map((condition, i) => (i === index ? next : condition)));
  }
  function updateAction(index: number, next: ActionDraft): void {
    setActions(draft.actions.map((action, i) => (i === index ? next : action)));
  }

  const trigger = draft.trigger;
  return (
    <div className="grid gap-4">
      <div data-testid={`automations-${prefix}-trigger-editor`}>
        <Paragraph className="text-ui-sm font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">
          Trigger
        </Paragraph>
        <div className="mt-1 flex flex-wrap items-end gap-3">
          <label className="text-ui-sm text-ink">
            Kind
            <select
              className={CONTROL_CLASS}
              data-testid={`automations-${prefix}-trigger-kind`}
              value={trigger.kind}
              onChange={(e) => {
                const kind = e.target.value;
                if (kind === "event") setTrigger({ kind: "event", action: "" });
                else if (kind === "due")
                  setTrigger({ kind: "due", subjectType: "", anchorField: "", direction: "before", offsetMinutes: "60" });
                else setTrigger({ kind: "json", json: "" });
              }}
            >
              <option value="event">Event — an audit action fires</option>
              <option value="due">Due — a date field ± offset</option>
              <option value="json">Raw JSON — a shape this build does not draw</option>
            </select>
          </label>
          {trigger.kind === "event" ? (
            <label className="text-ui-sm text-ink">
              Audit action — exact match
              <Input
                className="mt-1 block w-72 font-mono"
                data-testid={`automations-${prefix}-trigger-action`}
                list="automations-audit-actions"
                placeholder="task.created"
                value={trigger.action}
                onChange={(e) => {
                  setTrigger({ kind: "event", action: e.target.value });
                }}
              />
            </label>
          ) : null}
          {trigger.kind === "due" ? (
            <>
              <label className="text-ui-sm text-ink">
                Record type
                <Input
                  className="mt-1 block w-40 font-mono"
                  data-testid={`automations-${prefix}-trigger-subject`}
                  placeholder="task"
                  value={trigger.subjectType}
                  onChange={(e) => {
                    setTrigger({ ...trigger, subjectType: e.target.value });
                  }}
                />
              </label>
              <label className="text-ui-sm text-ink">
                Date field
                <Input
                  className="mt-1 block w-40 font-mono"
                  data-testid={`automations-${prefix}-trigger-anchor`}
                  placeholder="dueAt"
                  value={trigger.anchorField}
                  onChange={(e) => {
                    setTrigger({ ...trigger, anchorField: e.target.value });
                  }}
                />
              </label>
              <label className="text-ui-sm text-ink">
                Direction
                <select
                  className={CONTROL_CLASS}
                  data-testid={`automations-${prefix}-trigger-direction`}
                  value={trigger.direction}
                  onChange={(e) => {
                    setTrigger({ ...trigger, direction: e.target.value as "before" | "after" });
                  }}
                >
                  <option value="before">before</option>
                  <option value="after">after</option>
                </select>
              </label>
              <label className="text-ui-sm text-ink">
                Offset (minutes, 5–129600)
                <Input
                  className="mt-1 block w-36"
                  type="number"
                  data-testid={`automations-${prefix}-trigger-offset`}
                  value={trigger.offsetMinutes}
                  onChange={(e) => {
                    setTrigger({ ...trigger, offsetMinutes: e.target.value });
                  }}
                />
              </label>
            </>
          ) : null}
          {trigger.kind === "json" ? (
            <label className="block w-full text-ui-sm text-ink">
              Trigger (JSON, verbatim — the server re-judges it)
              <textarea
                className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] font-mono text-ui text-ink"
                rows={4}
                data-testid={`automations-${prefix}-trigger-json`}
                value={trigger.json}
                onChange={(e) => {
                  setTrigger({ kind: "json", json: e.target.value });
                }}
              />
            </label>
          ) : null}
          {trigger.kind === "due" ? (
            <Paragraph className="text-ui-sm text-ink-soft" data-testid={`automations-${prefix}-due-note`}>
              The date field must be an anchor the record type has registered — an unregistered
              pair saves fine but never fires, and the worker logs a warning. Event triggers see
              only the event's action / target / actor / detail.
            </Paragraph>
          ) : null}
          <datalist id="automations-audit-actions">
            {COMMON_AUDIT_ACTIONS.map((action) => (
              <option key={action} value={action} />
            ))}
          </datalist>
        </div>
      </div>

      <div data-testid={`automations-${prefix}-conditions-editor`}>
        <Paragraph className="text-ui-sm font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">
          Conditions — all must pass (empty = always)
        </Paragraph>
        {draft.conditions.map((condition, index) => (
          <div key={index} className="mt-2 flex flex-wrap items-end gap-3" data-testid={`automations-${prefix}-condition-row`}>
            <label className="text-ui-sm text-ink">
              Path
              <Input
                className="mt-1 block w-56 font-mono"
                data-testid={`automations-${prefix}-condition-path`}
                placeholder="detail.to"
                value={condition.path}
                onChange={(e) => {
                  updateCondition(index, { ...condition, path: e.target.value });
                }}
              />
            </label>
            <label className="text-ui-sm text-ink">
              Op
              <select
                className={CONTROL_CLASS}
                data-testid={`automations-${prefix}-condition-op`}
                value={condition.op}
                onChange={(e) => {
                  const op = e.target.value;
                  updateCondition(index, {
                    ...condition,
                    op: CONDITION_OPS.find((candidate) => candidate === op) ?? "eq",
                    value: op === "exists" ? "true" : condition.value,
                  });
                }}
              >
                {CONDITION_OPS.map((op) => (
                  <option key={op} value={op}>
                    {OP_LABELS[op]}
                  </option>
                ))}
              </select>
            </label>
            {condition.op === "exists" ? (
              <label className="text-ui-sm text-ink">
                Must exist
                <select
                  className={CONTROL_CLASS}
                  data-testid={`automations-${prefix}-condition-value`}
                  value={condition.value}
                  onChange={(e) => {
                    updateCondition(index, { ...condition, value: e.target.value });
                  }}
                >
                  <option value="true">true — must exist</option>
                  <option value="false">false — must not</option>
                </select>
              </label>
            ) : (
              <label className="text-ui-sm text-ink">
                Value (JSON — strings need quotes)
                <Input
                  className="mt-1 block w-64 font-mono"
                  data-testid={`automations-${prefix}-condition-value`}
                  value={condition.value}
                  onChange={(e) => {
                    updateCondition(index, { ...condition, value: e.target.value });
                  }}
                />
              </label>
            )}
            <Button
              variant="default"
              size="sm"
              data-testid={`automations-${prefix}-condition-remove`}
              onClick={() => {
                setConditions(draft.conditions.filter((_, i) => i !== index));
              }}
            >
              Remove
            </Button>
          </div>
        ))}
        <div className="mt-2">
          <Button
            variant="default"
            size="sm"
            data-testid={`automations-${prefix}-condition-add`}
            onClick={() => {
              setConditions([...draft.conditions, emptyConditionDraft()]);
            }}
          >
            Add condition
          </Button>
        </div>
      </div>

      <div data-testid={`automations-${prefix}-actions-editor`}>
        <Paragraph className="text-ui-sm font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">
          Actions — 1 to 10, run in order
        </Paragraph>
        {draft.actions.map((action, index) => (
          <div key={index} className="mt-2 rounded-control border border-line p-3" data-testid={`automations-${prefix}-action-row`}>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-ui-sm text-ink">
                Type
                <select
                  className={CONTROL_CLASS}
                  data-testid={`automations-${prefix}-action-type`}
                  value={action.type}
                  onChange={(e) => {
                    const type = e.target.value;
                    if (type === "create_task") updateAction(index, emptyActionDraft());
                    else if (type === "notify") updateAction(index, { type: "notify", userIdsText: "", title: "", body: "" });
                    else if (type === "send_email") updateAction(index, { type: "send_email", userIdsText: "", subject: "", body: "" });
                    else if (type === "send_webhook") updateAction(index, { type: "send_webhook", url: "", method: "POST", headersText: "", bodyText: "" });
                    else if (type === "update_field") updateAction(index, { type: "update_field", subjectType: "", field: "", valueText: "" });
                    else updateAction(index, { type: "json", json: "" });
                  }}
                >
                  <option value="create_task">Create task</option>
                  <option value="notify">Notify (in-app bell)</option>
                  <option value="send_email">Send email</option>
                  <option value="send_webhook">Webhook (outbound)</option>
                  <option value="update_field">Update a field</option>
                  <option value="json">Raw JSON — a type this build does not draw</option>
                </select>
              </label>
              <Button
                variant="default"
                size="sm"
                data-testid={`automations-${prefix}-action-remove`}
                onClick={() => {
                  setActions(draft.actions.filter((_, i) => i !== index));
                }}
              >
                Remove
              </Button>
            </div>
            {action.type === "create_task" ? (
              <div className="mt-2 grid gap-2">
                <label className="text-ui-sm text-ink">
                  Title
                  <Input
                    className="mt-1 block w-full"
                    data-testid={`automations-${prefix}-action-title`}
                    value={action.title}
                    onChange={(e) => {
                      updateAction(index, { ...action, title: e.target.value });
                    }}
                  />
                </label>
                <label className="text-ui-sm text-ink">
                  Description (optional)
                  <Input
                    className="mt-1 block w-full"
                    data-testid={`automations-${prefix}-action-description`}
                    value={action.description}
                    onChange={(e) => {
                      updateAction(index, { ...action, description: e.target.value });
                    }}
                  />
                </label>
                <div className="flex flex-wrap gap-3">
                  <label className="text-ui-sm text-ink">
                    Assignee id (optional)
                    <Input
                      className="mt-1 block w-72 font-mono"
                      data-testid={`automations-${prefix}-action-assignee`}
                      value={action.assigneeId}
                      onChange={(e) => {
                        updateAction(index, { ...action, assigneeId: e.target.value });
                      }}
                    />
                  </label>
                  <label className="text-ui-sm text-ink">
                    Due in hours (optional, 1–2160)
                    <Input
                      className="mt-1 block w-40"
                      type="number"
                      data-testid={`automations-${prefix}-action-due-hours`}
                      value={action.dueInHours}
                      onChange={(e) => {
                        updateAction(index, { ...action, dueInHours: e.target.value });
                      }}
                    />
                  </label>
                </div>
              </div>
            ) : null}
            {action.type === "notify" ? (
              <div className="mt-2 grid gap-2">
                <label className="text-ui-sm text-ink">
                  Recipient ids — one per line (1–50)
                  <textarea
                    className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] font-mono text-ui text-ink"
                    rows={2}
                    data-testid={`automations-${prefix}-action-user-ids`}
                    value={action.userIdsText}
                    onChange={(e) => {
                      updateAction(index, { ...action, userIdsText: e.target.value });
                    }}
                  />
                </label>
                <label className="text-ui-sm text-ink">
                  Title
                  <Input
                    className="mt-1 block w-full"
                    data-testid={`automations-${prefix}-action-notify-title`}
                    value={action.title}
                    onChange={(e) => {
                      updateAction(index, { ...action, title: e.target.value });
                    }}
                  />
                </label>
                <label className="text-ui-sm text-ink">
                  Body (optional)
                  <Input
                    className="mt-1 block w-full"
                    data-testid={`automations-${prefix}-action-notify-body`}
                    value={action.body}
                    onChange={(e) => {
                      updateAction(index, { ...action, body: e.target.value });
                    }}
                  />
                </label>
              </div>
            ) : null}
            {action.type === "send_email" ? (
              <div className="mt-2 grid gap-2">
                <Paragraph className="text-ui-sm text-ink-soft">
                  Recipients are in-app users — the mail goes to each account's address at send time.
                  A rule cannot mail arbitrary external addresses, and a deleted recipient fails the
                  action (retry, then a visible failure) instead of skipping them quietly.
                </Paragraph>
                <label className="text-ui-sm text-ink">
                  Recipient ids — one per line (1–50)
                  <textarea
                    className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] font-mono text-ui text-ink"
                    rows={2}
                    data-testid={`automations-${prefix}-action-email-user-ids`}
                    value={action.userIdsText}
                    onChange={(e) => {
                      updateAction(index, { ...action, userIdsText: e.target.value });
                    }}
                  />
                </label>
                <label className="text-ui-sm text-ink">
                  Subject
                  <Input
                    className="mt-1 block w-full"
                    data-testid={`automations-${prefix}-action-email-subject`}
                    value={action.subject}
                    onChange={(e) => {
                      updateAction(index, { ...action, subject: e.target.value });
                    }}
                  />
                </label>
                <label className="text-ui-sm text-ink">
                  Body (plain text — the html version is derived from it)
                  <textarea
                    className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] font-mono text-ui text-ink"
                    rows={4}
                    data-testid={`automations-${prefix}-action-email-body`}
                    value={action.body}
                    onChange={(e) => {
                      updateAction(index, { ...action, body: e.target.value });
                    }}
                  />
                </label>
              </div>
            ) : null}
            {action.type === "send_webhook" ? (
              <div className="mt-2 grid gap-2">
                <Paragraph className="text-ui-sm text-ink-soft">
                  The target must be https on a public host — loopback, private ranges, and
                  *.local / *.internal names are refused at save time and re-checked (DNS included,
                  every resolved address) at send time. Delivery is at-least-once: a timeout or 5xx
                  after the receiver processed the request means the same payload may arrive twice.
                </Paragraph>
                <label className="text-ui-sm text-ink">
                  URL (https, public host)
                  <Input
                    className="mt-1 block w-full font-mono"
                    data-testid={`automations-${prefix}-action-webhook-url`}
                    value={action.url}
                    onChange={(e) => {
                      updateAction(index, { ...action, url: e.target.value });
                    }}
                  />
                </label>
                <label className="text-ui-sm text-ink">
                  Method
                  <select
                    className={CONTROL_CLASS}
                    data-testid={`automations-${prefix}-action-webhook-method`}
                    value={action.method}
                    onChange={(e) => {
                      updateAction(index, { ...action, method: e.target.value });
                    }}
                  >
                    <option value="POST">POST</option>
                    <option value="PUT">PUT</option>
                    <option value="PATCH">PATCH</option>
                  </select>
                </label>
                <label className="text-ui-sm text-ink">
                  Headers — one per line as &quot;Name: Value&quot; (optional, at most 10; secrets
                  here live in the rule config and never appear in run errors)
                  <textarea
                    className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] font-mono text-ui text-ink"
                    rows={2}
                    data-testid={`automations-${prefix}-action-webhook-headers`}
                    value={action.headersText}
                    onChange={(e) => {
                      updateAction(index, { ...action, headersText: e.target.value });
                    }}
                  />
                </label>
                <label className="text-ui-sm text-ink">
                  Body — JSON (optional; sent as application/json, exactly as saved — no
                  templating)
                  <textarea
                    className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] font-mono text-ui text-ink"
                    rows={4}
                    data-testid={`automations-${prefix}-action-webhook-body`}
                    value={action.bodyText}
                    onChange={(e) => {
                      updateAction(index, { ...action, bodyText: e.target.value });
                    }}
                  />
                </label>
              </div>
            ) : null}
            {action.type === "update_field" ? (
              <div className="mt-2 grid gap-2">
                <Paragraph className="text-ui-sm text-ink-soft">
                  Changes one field on the record this rule fired for (the trigger&apos;s own row —
                  never a query). Only fields the owning domain registered are writable: an
                  unregistered subject type or field saves fine but fails loudly at run time with an
                  alert. A record under an electronic signature is locked — the update is refused.
                  Setting a value the field already has is a quiet success: no row write, no audit
                  entry.
                </Paragraph>
                <label className="text-ui-sm text-ink">
                  Subject type (e.g. task)
                  <Input
                    className="mt-1 block w-full font-mono"
                    data-testid={`automations-${prefix}-action-field-subject`}
                    value={action.subjectType}
                    onChange={(e) => {
                      updateAction(index, { ...action, subjectType: e.target.value });
                    }}
                  />
                </label>
                <label className="text-ui-sm text-ink">
                  Field (e.g. status)
                  <Input
                    className="mt-1 block w-full font-mono"
                    data-testid={`automations-${prefix}-action-field-name`}
                    value={action.field}
                    onChange={(e) => {
                      updateAction(index, { ...action, field: e.target.value });
                    }}
                  />
                </label>
                <label className="text-ui-sm text-ink">
                  Value — JSON (exactly as saved, no templating; null allowed)
                  <textarea
                    className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] font-mono text-ui text-ink"
                    rows={3}
                    data-testid={`automations-${prefix}-action-field-value`}
                    value={action.valueText}
                    onChange={(e) => {
                      updateAction(index, { ...action, valueText: e.target.value });
                    }}
                  />
                </label>
              </div>
            ) : null}
            {action.type === "json" ? (
              <label className="mt-2 block text-ui-sm text-ink">
                Action (JSON, verbatim — the server re-judges it)
                <textarea
                  className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] font-mono text-ui text-ink"
                  rows={4}
                  data-testid={`automations-${prefix}-action-json`}
                  value={action.json}
                  onChange={(e) => {
                    updateAction(index, { type: "json", json: e.target.value });
                  }}
                />
              </label>
            ) : null}
          </div>
        ))}
        <div className="mt-2">
          <Button
            variant="default"
            size="sm"
            data-testid={`automations-${prefix}-action-add`}
            onClick={() => {
              setActions([...draft.actions, emptyActionDraft()]);
            }}
          >
            Add action
          </Button>
        </div>
      </div>
    </div>
  );
}

function RevisionChanges({ changes }: { changes: PathChange[] }) {
  if (changes.length === 0) {
    return <span className="text-ink-soft">no content change</span>;
  }
  const shown = changes.slice(0, 3);
  return (
    <span className="font-mono text-ui-sm text-ink-soft" data-testid="automations-revision-changes">
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

/** One run row's conditions cell — per-condition verdicts; an outcome the
 *  parser cannot draw falls back to raw JSON. */
function RunConditionsCell({ run }: { run: AutomationRunRow }) {
  if (run.conditionResults.length === 0) {
    return <span className="text-ink-soft">always</span>;
  }
  const outcomes: ConditionOutcomeView[] = [];
  for (const raw of run.conditionResults) {
    const outcome = parseConditionOutcome(raw);
    if (outcome === null) {
      return <span className="font-mono text-ui-sm">{jsonShort(run.conditionResults, 120)}</span>;
    }
    outcomes.push(outcome);
  }
  return (
    <span className="font-mono text-ui-sm" data-testid="automations-run-conditions">
      {outcomes.map((outcome) => (
        <span key={outcome.path} className="block">
          {outcome.path} {OP_LABELS[outcome.op] ?? outcome.op}{" "}
          {outcome.passed ? "✓" : <span className="text-err">✗</span>}
        </span>
      ))}
    </span>
  );
}

/** One run row's actions cell — per-action outcomes with the created task's
 *  ref when there is one. */
function RunActionsCell({ run }: { run: AutomationRunRow }) {
  const actionResults = run.actionResults;
  if (actionResults === null) {
    return <span className="text-ink-soft">—</span>;
  }
  if (actionResults.length === 0) {
    return <span className="text-ink-soft">no actions ran</span>;
  }
  const drawn = actionResults.map(parseActionResult);
  return (
    <span className="font-mono text-ui-sm" data-testid="automations-run-actions">
      {drawn.map((result, index) => (
        <span key={index} className="block">
          {result === null ? (
            jsonShort(actionResults[index], 80)
          ) : (
            <>
              {result.type} {result.status === "succeeded" ? "✓" : <span className="text-err">✗</span>}
              {result.ref !== null ? ` → ${shortId(result.ref)}` : ""}
              {result.error !== null ? ` — ${result.error}` : ""}
            </>
          )}
        </span>
      ))}
    </span>
  );
}

export function Automations(): ReactElement {
  const queryClient = useQueryClient();

  const [filters, setFilters] = useState<AutomationsFilters>({ query: "", kind: "all", state: "all" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createSpec, setCreateSpec] = useState<SpecDraft>(emptySpecDraft());
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editSpec, setEditSpec] = useState<SpecDraft>(emptySpecDraft());
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);

  const [runsStatus, setRunsStatus] = useState<"all" | (typeof AUTOMATION_RUN_STATUSES)[number]>("all");
  const [runsRuleOnly, setRunsRuleOnly] = useState(false);

  const [rollbackVersion, setRollbackVersion] = useState("");
  const [rollbackReason, setRollbackReason] = useState("");
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);

  const rulesQuery = useQuery({
    queryKey: ["automations-rules"],
    queryFn: () => automationsAdapters.list(),
  });
  const rules = rulesQuery.data?.ok ? rulesQuery.data.data : undefined;
  const unavailable =
    (rulesQuery.data?.ok === false && rulesQuery.data.reason === "unavailable") || rules === undefined;
  const forbidden = rulesQuery.data?.ok === false && rulesQuery.data.reason === "forbidden";

  const filtered = rules !== undefined ? filterRules(rules, filters) : [];
  const selected = rules?.find((rule) => rule.id === selectedId) ?? null;

  const runsQuery = useQuery({
    queryKey: ["automations-runs", runsStatus, runsRuleOnly ? selectedId : null],
    queryFn: () =>
      automationsAdapters.runs({
        ...(runsStatus !== "all" ? { status: runsStatus } : {}),
        ...(runsRuleOnly && selectedId !== null ? { ruleId: selectedId } : {}),
        limit: 50,
      }),
    enabled: rulesQuery.isSuccess,
  });
  const runs = runsQuery.data?.ok ? runsQuery.data.data : undefined;

  const historyQuery = useQuery({
    queryKey: ["automations-history", selectedId],
    queryFn: () => automationsAdapters.history(selectedId ?? ""),
    enabled: selectedId !== null,
  });
  const history = historyQuery.data?.ok ? historyQuery.data.data : undefined;

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ["automations-rules"] });
    void queryClient.invalidateQueries({ queryKey: ["automations-runs"] });
    void queryClient.invalidateQueries({ queryKey: ["automations-history"] });
  }

  function openDetail(rule: AutomationRuleRow): void {
    setFlash(null);
    setSelectedId(rule.id);
    setEditOpen(false);
    setEditError(null);
    setDeleteArmed(false);
    setRollbackError(null);
  }

  function openCreate(): void {
    setFlash(null);
    setCreateOpen(true);
    setCreateName("");
    setCreateDescription("");
    setCreateSpec(emptySpecDraft());
    setCreateError(null);
  }

  async function submitCreate(): Promise<void> {
    if (!createOpen) return;
    if (createName.trim() === "") {
      setCreateError("The rule needs a name.");
      return;
    }
    const built = buildSpec(createSpec);
    if (!built.ok) {
      setCreateError(built.error);
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    const description = buildDescription(createDescription);
    const result = await automationsAdapters.create({
      name: createName.trim(),
      ...(description !== null ? { description } : {}),
      spec: built.value,
    });
    setCreateBusy(false);
    if (!result.ok) {
      setCreateError(
        result.reason === "forbidden"
          ? "The server refused — creating rules needs the automations permission."
          : result.reason === "invalid"
            ? "The server rejected the spec — check the fields and try again."
            : "The rule could not be saved. Reload and try again.",
      );
      return;
    }
    setCreateOpen(false);
    setFlash("Rule created — it goes live for the next matching event.");
    refresh();
  }

  function openEdit(rule: AutomationRuleRow): void {
    setFlash(null);
    setEditOpen(true);
    setEditName(rule.name);
    setEditDescription(rule.description ?? "");
    setEditSpec(specToDraft({ trigger: rule.trigger, conditions: rule.conditions, actions: rule.actions }));
    setEditError(null);
  }

  async function submitEdit(): Promise<void> {
    if (selected === null || !editOpen) return;
    if (editName.trim() === "") {
      setEditError("The rule needs a name.");
      return;
    }
    const built = buildSpec(editSpec);
    if (!built.ok) {
      setEditError(built.error);
      return;
    }
    setEditBusy(true);
    setEditError(null);
    const beforeVersion = selected.version;
    const result = await automationsAdapters.update(selected.id, {
      name: editName.trim(),
      description: buildDescription(editDescription),
      spec: built.value,
    });
    setEditBusy(false);
    if (!result.ok) {
      setEditError(
        result.reason === "forbidden"
          ? "The server refused — changing rules needs the automations permission."
          : result.reason === "not_found"
            ? "This rule no longer exists — someone removed it while you were editing."
            : result.reason === "invalid"
              ? "The server rejected the spec — check the fields and try again."
              : "The change could not be saved. Reload and try again.",
      );
      return;
    }
    setEditOpen(false);
    setFlash(
      result.data.version === beforeVersion
        ? `No effective change — version ${result.data.version} stands.`
        : `Saved — version ${result.data.version} is live now, the ledger has the change.`,
    );
    refresh();
  }

  async function toggleEnabled(rule: AutomationRuleRow): Promise<void> {
    setToggleBusy(true);
    setFlash(null);
    const result = await automationsAdapters.update(rule.id, { enabled: !rule.enabled });
    setToggleBusy(false);
    if (!result.ok) {
      setFlash("The switch could not be flipped. Reload and try again.");
      return;
    }
    setFlash(
      !rule.enabled
        ? `Rule resumed — the scanner picks it up on its next cycle (v${result.data.version}).`
        : `Rule paused — the scanner skips paused rules (v${result.data.version}).`,
    );
    refresh();
  }

  async function submitDelete(rule: AutomationRuleRow): Promise<void> {
    setDeleteBusy(true);
    setFlash(null);
    const result = await automationsAdapters.remove(rule.id);
    setDeleteBusy(false);
    setDeleteArmed(false);
    if (!result.ok) {
      setFlash(
        result.reason === "not_found"
          ? "This rule was already removed — its run log stays on the record."
          : "The rule could not be deleted. Reload and try again.",
      );
      refresh();
      return;
    }
    setSelectedId(null);
    setFlash("Rule deleted — its run log stays on the record.");
    refresh();
  }

  async function submitRollback(): Promise<void> {
    if (selected === null || rollbackVersion === "") return;
    setRollbackBusy(true);
    setRollbackError(null);
    const reason = rollbackReason.trim();
    const result = await automationsAdapters.rollback(
      selected.id,
      Number(rollbackVersion),
      reason === "" ? undefined : reason,
    );
    setRollbackBusy(false);
    if (!result.ok) {
      setRollbackError(
        result.reason === "forbidden"
          ? "The server refused the rollback — it needs the automations permission."
          : result.reason === "not_found"
            ? "That version is not in the ledger — someone else may have rolled back meanwhile."
            : result.reason === "no_change"
              ? "That version is already the live one — nothing to roll back."
              : "The rollback could not be saved. Reload and try again.",
      );
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
    <div className="w-full" data-page="automations" data-testid="automations-root">
      <Card>
        <Heading as="h2">Automation rules</Heading>
        <Paragraph className="text-ink-soft">
          A rule is trigger → conditions → actions, saved as data and executed by the background
          worker. Saving goes live immediately — the scanner reads enabled rules every cycle, and
          there is no publish step. Every execution leaves a run row below; failed actions retry
          with backoff and every attempt is on the record.
        </Paragraph>

        {flash !== null ? (
          <Paragraph className="mt-3 text-ink" data-testid="automations-flash">
            {flash}
          </Paragraph>
        ) : null}

        {rulesQuery.isPending ? (
          <Paragraph className="mt-3" data-testid="automations-loading">
            Loading…
          </Paragraph>
        ) : forbidden ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="automations-forbidden">
            The automation studio needs the automations permission — ask an administrator. Rules
            change how the whole company reacts to events, so the page has no read-only half.
          </Paragraph>
        ) : unavailable ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="automations-unavailable">
            The automation rules could not be loaded.
          </Paragraph>
        ) : rules.length === 0 ? (
          <div data-testid="automations-empty">
            <Paragraph className="mt-3 text-ink-soft">
              No rules yet — create the first one, e.g. “when a task is created, notify me”.
            </Paragraph>
            <div className="mt-3">
              <Button variant="primary" size="sm" data-testid="automations-new-empty" onClick={openCreate}>
                New rule
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-3">
              <Button variant="primary" size="sm" data-testid="automations-new" onClick={openCreate}>
                New rule
              </Button>
            </div>

            {createOpen ? (
              <div className="mt-3 rounded-card border border-line p-4" data-testid="automations-create-form">
                <Heading as="h3">New rule</Heading>
                <Paragraph className="mt-1 text-ui-sm text-ink-soft">
                  Saving goes live immediately — the worker picks the rule up on its next cycle.
                </Paragraph>
                <div className="mt-3 grid gap-3">
                  <label className="text-ui-sm text-ink">
                    Name
                    <Input
                      className="mt-1 block w-full"
                      data-testid="automations-create-name"
                      value={createName}
                      onChange={(e) => {
                        setCreateName(e.target.value);
                      }}
                    />
                  </label>
                  <label className="text-ui-sm text-ink">
                    Description (optional)
                    <Input
                      className="mt-1 block w-full"
                      data-testid="automations-create-description"
                      value={createDescription}
                      onChange={(e) => {
                        setCreateDescription(e.target.value);
                      }}
                    />
                  </label>
                  <SpecEditor draft={createSpec} onChange={setCreateSpec} prefix="create" />
                </div>
                {createError !== null ? (
                  <Paragraph className="mt-2 text-err font-medium" data-testid="automations-create-error">
                    {createError}
                  </Paragraph>
                ) : null}
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={createBusy}
                    data-testid="automations-create-submit"
                    onClick={() => {
                      void submitCreate();
                    }}
                  >
                    {createBusy ? "Saving…" : "Create rule"}
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    disabled={createBusy}
                    data-testid="automations-create-cancel"
                    onClick={() => {
                      setCreateOpen(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="mt-3 flex flex-wrap items-end gap-3" data-testid="automations-filters">
              <label className="text-ui-sm text-ink">
                Find
                <Input
                  className="mt-1 block w-64"
                  data-testid="automations-filter-query"
                  value={filters.query}
                  placeholder="name or description…"
                  onChange={(e) => {
                    setFilters({ ...filters, query: e.target.value });
                  }}
                />
              </label>
              <label className="text-ui-sm text-ink">
                Trigger
                <select
                  className={CONTROL_CLASS}
                  data-testid="automations-filter-kind"
                  value={filters.kind}
                  onChange={(e) => {
                    setFilters({ ...filters, kind: e.target.value as AutomationsFilters["kind"] });
                  }}
                >
                  <option value="all">All triggers</option>
                  <option value="event">Event</option>
                  <option value="due">Due</option>
                </select>
              </label>
              <label className="text-ui-sm text-ink">
                State
                <select
                  className={CONTROL_CLASS}
                  data-testid="automations-filter-state"
                  value={filters.state}
                  onChange={(e) => {
                    setFilters({ ...filters, state: e.target.value as AutomationsFilters["state"] });
                  }}
                >
                  <option value="all">All states</option>
                  <option value="enabled">Enabled</option>
                  <option value="paused">Paused</option>
                </select>
              </label>
            </div>

            <div className="mt-3 overflow-x-auto" data-testid="automations-table">
              <table className="w-full border-collapse text-left text-ui-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">Rule</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">Trigger</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">Conditions</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">Actions</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">State</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">Ver</th>
                    <th className="py-2 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft"> </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((rule) => (
                    <tr key={rule.id} className="border-b border-line align-top" data-testid="automations-row">
                      <td className="py-2 pr-4">
                        <span className="font-medium">{rule.name}</span>
                        {rule.description !== null ? (
                          <span className="block text-ink-soft">{rule.description}</span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-4 font-mono" data-testid="automations-row-trigger">
                        {triggerSummary(rule.trigger)}
                      </td>
                      <td className="py-2 pr-4 text-ink-soft">{conditionsSummary(rule.conditions)}</td>
                      <td className="py-2 pr-4 font-mono text-ink-soft" data-testid="automations-row-actions">
                        {actionsSummary(rule.actions)}
                      </td>
                      <td className="py-2 pr-4">
                        {rule.enabled ? (
                          <span data-testid="automations-row-state">enabled</span>
                        ) : (
                          <span className="text-ink-soft" data-testid="automations-row-state">
                            paused
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-4 font-mono text-ink-soft">v{rule.version}</td>
                      <td className="py-2">
                        <Button
                          variant="default"
                          size="sm"
                          data-testid="automations-row-open"
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
                      <td colSpan={7} className="py-3 text-ink-soft" data-testid="automations-filter-empty">
                        No rule matches these filters.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            {selected !== null ? (
              <div className="mt-4 rounded-card border border-line p-4" data-testid="automations-detail">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Heading as="h3">{selected.name}</Heading>
                  <span className="font-mono text-[length:var(--fs-meta)] uppercase tracking-[var(--ls-crumb)] text-ink-soft">
                    {selected.enabled ? "enabled" : "paused"} · v{selected.version}
                  </span>
                </div>
                {selected.description !== null ? (
                  <Paragraph className="mt-1 text-ui-sm text-ink-soft">{selected.description}</Paragraph>
                ) : null}

                <div className="mt-3">
                  <SpecDisplay rule={selected} />
                </div>

                {editOpen ? (
                  <div className="mt-3 rounded-card border border-line p-4" data-testid="automations-edit-form">
                    <Heading as="h3">Edit rule</Heading>
                    <Paragraph className="mt-1 text-ui-sm text-ink-soft">
                      The spec is replaced whole — trigger, conditions and actions together. In-flight
                      runs keep the spec they started under; the change applies to the next match.
                    </Paragraph>
                    <div className="mt-3 grid gap-3">
                      <label className="text-ui-sm text-ink">
                        Name
                        <Input
                          className="mt-1 block w-full"
                          data-testid="automations-edit-name"
                          value={editName}
                          onChange={(e) => {
                            setEditName(e.target.value);
                          }}
                        />
                      </label>
                      <label className="text-ui-sm text-ink">
                        Description (optional — empty clears it)
                        <Input
                          className="mt-1 block w-full"
                          data-testid="automations-edit-description"
                          value={editDescription}
                          onChange={(e) => {
                            setEditDescription(e.target.value);
                          }}
                        />
                      </label>
                      <SpecEditor draft={editSpec} onChange={setEditSpec} prefix="edit" />
                    </div>
                    {editError !== null ? (
                      <Paragraph className="mt-2 text-err font-medium" data-testid="automations-edit-error">
                        {editError}
                      </Paragraph>
                    ) : null}
                    <div className="mt-3 flex gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={editBusy}
                        data-testid="automations-edit-submit"
                        onClick={() => {
                          void submitEdit();
                        }}
                      >
                        {editBusy ? "Saving…" : "Save change"}
                      </Button>
                      <Button
                        variant="default"
                        size="sm"
                        disabled={editBusy}
                        data-testid="automations-edit-cancel"
                        onClick={() => {
                          setEditOpen(false);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button variant="primary" size="sm" data-testid="automations-detail-edit" onClick={() => { openEdit(selected); }}>
                      Edit rule
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      disabled={toggleBusy}
                      data-testid="automations-detail-toggle"
                      onClick={() => {
                        void toggleEnabled(selected);
                      }}
                    >
                      {selected.enabled ? "Pause" : "Resume"}
                    </Button>
                    {deleteArmed ? (
                      <Button
                        variant="default"
                        size="sm"
                        disabled={deleteBusy}
                        className="text-err"
                        data-testid="automations-detail-delete-confirm"
                        onClick={() => {
                          void submitDelete(selected);
                        }}
                      >
                        {deleteBusy ? "Deleting…" : "Confirm delete"}
                      </Button>
                    ) : (
                      <Button
                        variant="default"
                        size="sm"
                        data-testid="automations-detail-delete"
                        onClick={() => {
                          setDeleteArmed(true);
                        }}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                )}
                {deleteArmed && !editOpen ? (
                  <Paragraph className="mt-2 text-ui-sm text-ink-soft" data-testid="automations-delete-note">
                    Deleting removes the rule; it cannot be re-enabled. The run log outlives the
                    config — every past execution stays readable below.
                  </Paragraph>
                ) : null}

                <div className="mt-4 border-t border-line pt-3" data-testid="automations-history">
                  <Heading as="h3">Version history</Heading>
                  {historyQuery.isPending || (historyQuery.fetchStatus === "idle" && history === undefined) ? (
                    <Paragraph className="mt-1 text-ink-soft" data-testid="automations-history-loading">
                      Loading history…
                    </Paragraph>
                  ) : historyQuery.data?.ok === false && historyQuery.data.reason === "forbidden" ? (
                    <Paragraph className="mt-1 text-ink-soft" data-testid="automations-history-forbidden">
                      The version ledger needs the automations permission.
                    </Paragraph>
                  ) : history === undefined ? (
                    <Paragraph className="mt-1 text-ink-soft" data-testid="automations-history-unavailable">
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
                            <tr key={revision.version} className="border-b border-line align-top" data-testid="automations-revision-row">
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
                        <div className="mt-3 rounded-control border border-line p-3" data-testid="automations-rollback-form">
                          <Paragraph className="text-ui-sm text-ink-soft">
                            One-click rollback — the restored version is recorded as a new version;
                            history is never rewritten, and the rollback itself is audited.
                          </Paragraph>
                          <div className="mt-2 flex flex-wrap items-end gap-3">
                            <label className="text-ui-sm text-ink">
                              Restore to
                              <select
                                className={CONTROL_CLASS}
                                data-testid="automations-rollback-select"
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
                                data-testid="automations-rollback-reason"
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
                              data-testid="automations-rollback-submit"
                              onClick={() => {
                                void submitRollback();
                              }}
                            >
                              {rollbackBusy ? "Rolling back…" : "Roll back"}
                            </Button>
                          </div>
                          {rollbackError !== null ? (
                            <Paragraph className="mt-2 text-err font-medium" data-testid="automations-rollback-error">
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

            <div className="mt-4 border-t border-line pt-3" data-testid="automations-runs">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Heading as="h3">Run log</Heading>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="text-ui-sm text-ink">
                    Status
                    <select
                      className={CONTROL_CLASS}
                      data-testid="automations-runs-status"
                      value={runsStatus}
                      onChange={(e) => {
                        const value = e.target.value;
                        setRunsStatus(
                          AUTOMATION_RUN_STATUSES.find((status) => status === value) ?? "all",
                        );
                      }}
                    >
                      <option value="all">All statuses</option>
                      {AUTOMATION_RUN_STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {RUN_STATUS_LABELS[status]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 pb-1 text-ui-sm text-ink">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--accent)]"
                      data-testid="automations-runs-rule-only"
                      disabled={selected === null}
                      checked={runsRuleOnly && selected !== null}
                      onChange={(e) => {
                        setRunsRuleOnly(e.target.checked);
                      }}
                    />
                    Selected rule only
                  </label>
                  <Button
                    variant="default"
                    size="sm"
                    data-testid="automations-runs-refresh"
                    onClick={() => {
                      void queryClient.invalidateQueries({ queryKey: ["automations-runs"] });
                    }}
                  >
                    Refresh
                  </Button>
                </div>
              </div>
              <Paragraph className="mt-1 text-ui-sm text-ink-soft">
                One row per (rule × event) hit — the latest 50. Skipped rows record why the
                conditions said no; failed rows record what to fix, and the worker has already
                retried them with backoff.
              </Paragraph>
              {runsQuery.isPending ? (
                <Paragraph className="mt-2" data-testid="automations-runs-loading">
                  Loading runs…
                </Paragraph>
              ) : runsQuery.data?.ok === false && runsQuery.data.reason === "forbidden" ? (
                <Paragraph className="mt-2 text-ink-soft" data-testid="automations-runs-forbidden">
                  The run log needs the automations permission.
                </Paragraph>
              ) : runs === undefined ? (
                <Paragraph className="mt-2 text-ink-soft" data-testid="automations-runs-unavailable">
                  The run log could not be loaded.
                </Paragraph>
              ) : runs.length === 0 ? (
                <Paragraph className="mt-2 text-ink-soft" data-testid="automations-runs-empty">
                  No runs match — nothing has fired under this filter yet.
                </Paragraph>
              ) : (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full border-collapse text-left text-ui-sm">
                    <thead>
                      <tr className="border-b border-line">
                        <th className="py-1 pr-4 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">When</th>
                        <th className="py-1 pr-4 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">Rule</th>
                        <th className="py-1 pr-4 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">Status</th>
                        <th className="py-1 pr-4 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">Conditions</th>
                        <th className="py-1 pr-4 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">Actions</th>
                        <th className="py-1 font-mono text-[length:var(--fs-meta)] font-medium uppercase tracking-[var(--ls-crumb)] text-ink-soft">Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((run) => (
                        <tr key={run.id} className="border-b border-line align-top" data-testid="automations-run-row">
                          <td className="py-1 pr-4 whitespace-nowrap text-ink-soft">{formatDateTime(run.createdAt)}</td>
                          <td className="py-1 pr-4" data-testid="automations-run-rule">{run.ruleName}</td>
                          <td className="py-1 pr-4 font-mono" data-testid="automations-run-status">
                            {RUN_STATUS_LABELS[run.status] ?? run.status}
                          </td>
                          <td className="py-1 pr-4">
                            <RunConditionsCell run={run} />
                          </td>
                          <td className="py-1 pr-4">
                            <RunActionsCell run={run} />
                          </td>
                          <td className="py-1 text-err" data-testid="automations-run-error">
                            {run.error ?? ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
