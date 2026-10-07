// The automation rules' data access (#224 config face): the rule CRUD, the
// run log read, and the #226 ledger's history + one-click rollback for the
// automation_rule family. Everything the page can do sits behind the server's
// `automations.configure` gate — unlike the rules registry there is no
// company-wide read half, so "forbidden" is a whole-page answer, not a form's.
//
//   { ok: true, data }                        — the call worked
//   { ok: false, reason: "forbidden" }        — 403: no automations.configure
//   { ok: false, reason: "unavailable" }      — network/5xx/unparseable body
// and the writes add the specific rejections the kernel speaks (bad body,
// missing rule). Response bodies are zod-parsed because API responses are
// external input as far as this bundle is concerned.
//
// The spec (trigger/conditions/actions) is an OPEN set stored as jsonb: the
// server accepts any shape its zod knows today, and new action types land
// without a migration. This client therefore never reduces a spec to strings
// it invents — display summaries are liberal (an unrecognized shape says so),
// and the edit draft keeps unknown trigger/action shapes as raw JSON the
// operator edits verbatim, so saving an old rule can never silently destroy
// a part this build has no editor for. The server re-judges everything.
import { z } from "zod";

export const AUTOMATION_RUN_STATUSES = ["pending", "skipped", "succeeded", "failed"] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

export const AUTOMATION_RULE_SUBJECT = "automation_rule";

const ruleRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  // trigger/conditions/actions are open jsonb sets — parsed liberally by the
  // display helpers below, never narrowed away
  trigger: z.unknown(),
  conditions: z.array(z.unknown()),
  actions: z.array(z.unknown()),
  enabled: z.boolean(),
  version: z.number().int(),
  createdById: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const runRowSchema = z.object({
  id: z.string(),
  ruleId: z.string().nullable(),
  // rule_name snapshot — the log outlives the rule (SET NULL)
  ruleName: z.string(),
  sourceEventId: z.string(),
  status: z.enum(AUTOMATION_RUN_STATUSES),
  conditionResults: z.array(z.unknown()),
  actionResults: z.array(z.unknown()).nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});

const rulesPageSchema = z.object({ rules: z.array(ruleRowSchema) });
const runsPageSchema = z.object({ runs: z.array(runRowSchema) });
const createdSchema = z.object({ id: z.string() });
const versionSchema = z.object({ version: z.number().int() });
const deletedSchema = z.object({ ok: z.boolean() });

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

export type AutomationRuleRow = z.infer<typeof ruleRowSchema>;
export type AutomationRunRow = z.infer<typeof runRowSchema>;
export type RuleRevision = z.infer<(typeof revisionsResponseSchema)["shape"]["revisions"]["element"]>;
export type PathChange = z.infer<typeof pathChangeSchema>;

export type AutomationsReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "forbidden" | "unavailable" };

export type CreateRuleFailure = "forbidden" | "invalid" | "unavailable";
export type UpdateRuleFailure = "forbidden" | "not_found" | "invalid" | "unavailable";
export type DeleteRuleFailure = "forbidden" | "not_found" | "unavailable";
export type RollbackFailure = "forbidden" | "not_found" | "no_change" | "unsupported" | "conflict" | "unavailable";

export interface RuleSpecValue {
  trigger: unknown;
  conditions: unknown[];
  actions: unknown[];
}

export interface CreateRuleInput {
  name: string;
  description?: string;
  spec: RuleSpecValue;
}

// Whole-spec replace, like the server's PATCH: bringing a spec means
// replacing the rule's trigger, conditions and actions in one write.
export interface UpdateRuleInput {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  spec?: RuleSpecValue;
}

export interface RunsFilter {
  ruleId?: string;
  status?: AutomationRunStatus;
  limit?: number;
}

async function readJson<T>(
  fetchFn: typeof fetch,
  schema: z.ZodType<T>,
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: T | null; error: string | null }> {
  try {
    const res = await fetchFn(url, init);
    const raw: unknown = await res.json().catch(() => null);
    const parsed = schema.safeParse(raw);
    return {
      status: res.status,
      body: parsed.success ? parsed.data : null,
      error:
        typeof raw === "object" && raw !== null && "error" in raw
          ? String(raw.error)
          : null,
    };
  } catch {
    return { status: 0, body: null, error: null };
  }
}

export interface AutomationsAdapters {
  list(): Promise<AutomationsReadResult<AutomationRuleRow[]>>;
  runs(filter: RunsFilter): Promise<AutomationsReadResult<AutomationRunRow[]>>;
  create(
    input: CreateRuleInput,
  ): Promise<{ ok: true; data: { id: string } } | { ok: false; reason: CreateRuleFailure }>;
  update(
    id: string,
    input: UpdateRuleInput,
  ): Promise<{ ok: true; data: { version: number } } | { ok: false; reason: UpdateRuleFailure }>;
  remove(id: string): Promise<{ ok: true } | { ok: false; reason: DeleteRuleFailure }>;
  history(subjectId: string): Promise<AutomationsReadResult<RuleRevision[]>>;
  rollback(
    subjectId: string,
    toVersion: number,
    reason?: string,
  ): Promise<{ ok: true; data: z.infer<typeof rollbackResponseSchema> } | { ok: false; reason: RollbackFailure }>;
}

export function createAutomationsAdapters(fetchFn: typeof fetch = fetch): AutomationsAdapters {
  return {
    async list() {
      const res = await readJson(fetchFn, rulesPageSchema, "/api/automations");
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status !== 200 || res.body === null) {
        return { ok: false as const, reason: "unavailable" as const };
      }
      return { ok: true as const, data: res.body.rules };
    },

    async runs(filter) {
      const params = new URLSearchParams();
      if (filter.ruleId !== undefined) params.set("ruleId", filter.ruleId);
      if (filter.status !== undefined) params.set("status", filter.status);
      if (filter.limit !== undefined) params.set("limit", String(filter.limit));
      const suffix = params.toString() === "" ? "" : `?${params.toString()}`;
      const res = await readJson(fetchFn, runsPageSchema, `/api/automations/runs${suffix}`);
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status !== 200 || res.body === null) {
        return { ok: false as const, reason: "unavailable" as const };
      }
      return { ok: true as const, data: res.body.runs };
    },

    async create(input) {
      const body: Record<string, unknown> = {
        name: input.name,
        trigger: input.spec.trigger,
        conditions: input.spec.conditions,
        actions: input.spec.actions,
      };
      if (input.description !== undefined) body.description = input.description;
      const res = await readJson(fetchFn, createdSchema, "/api/automations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status === 201 && res.body !== null) {
        return { ok: true as const, data: res.body };
      }
      return { ok: false as const, reason: res.status === 400 ? ("invalid" as const) : ("unavailable" as const) };
    },

    async update(id, input) {
      const body: Record<string, unknown> = {};
      if (input.name !== undefined) body.name = input.name;
      if (input.description !== undefined) body.description = input.description;
      if (input.enabled !== undefined) body.enabled = input.enabled;
      if (input.spec !== undefined) {
        body.spec = {
          trigger: input.spec.trigger,
          conditions: input.spec.conditions,
          actions: input.spec.actions,
        };
      }
      const res = await readJson(fetchFn, versionSchema, `/api/automations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status === 404) return { ok: false as const, reason: "not_found" as const };
      if (res.status === 200 && res.body !== null) {
        return { ok: true as const, data: res.body };
      }
      return { ok: false as const, reason: res.status === 400 ? ("invalid" as const) : ("unavailable" as const) };
    },

    async remove(id) {
      const res = await readJson(fetchFn, deletedSchema, `/api/automations/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status === 404) return { ok: false as const, reason: "not_found" as const };
      if (res.status === 200 && res.body !== null) {
        return { ok: true as const };
      }
      return { ok: false as const, reason: "unavailable" as const };
    },

    async history(subjectId) {
      const res = await readJson(
        fetchFn,
        revisionsResponseSchema,
        `/api/config-versions/${AUTOMATION_RULE_SUBJECT}/${encodeURIComponent(subjectId)}`,
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
        `/api/config-versions/${AUTOMATION_RULE_SUBJECT}/${encodeURIComponent(subjectId)}/rollback`,
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
      if (res.status === 409) return { ok: false as const, reason: "conflict" as const };
      if (res.status === 200 && res.body !== null) {
        return { ok: true as const, data: res.body };
      }
      return { ok: false as const, reason: "unavailable" as const };
    },
  };
}

// ---------------------------------------------------------------------------
// Display-side pure helpers — liberal on purpose. Display never plays
// validator and never invents a shape: a summary it cannot draw says so, and
// the detail panel falls back to raw JSON. The server's zod is the only
// authority over what a spec may be.
// ---------------------------------------------------------------------------

const DUE_OFFSET_MIN = 5;
const DUE_OFFSET_MAX = 129_600;

/** One human line for an offset in minutes: "45 min" / "6 h" / "7 d". */
export function formatOffset(minutes: number): string {
  if (minutes % 1440 === 0 && minutes >= 1440) return `${minutes / 1440} d`;
  if (minutes % 60 === 0 && minutes >= 60) return `${minutes / 60} h`;
  return `${minutes} min`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The trigger's kind as the list filters see it — "event" / "due" / the raw
 *  kind string of a shape this build does not draw, or null when unreadable. */
export function triggerKind(trigger: unknown): string | null {
  if (!isRecord(trigger)) return null;
  return typeof trigger.kind === "string" ? trigger.kind : null;
}

/** One line for the list's trigger column. Known shapes draw themselves;
 *  anything else names its kind or admits it cannot be drawn. */
export function triggerSummary(trigger: unknown): string {
  if (!isRecord(trigger)) return "Unreadable trigger";
  if (trigger.kind === "event" && typeof trigger.action === "string") {
    return `event · ${trigger.action}`;
  }
  if (
    trigger.kind === "due" &&
    typeof trigger.subjectType === "string" &&
    typeof trigger.anchorField === "string" &&
    (trigger.direction === "before" || trigger.direction === "after") &&
    typeof trigger.offsetMinutes === "number"
  ) {
    return `due · ${trigger.subjectType}.${trigger.anchorField} ${trigger.direction} ${formatOffset(trigger.offsetMinutes)}`;
  }
  const kind = triggerKind(trigger);
  return kind === null ? "Unreadable trigger" : `${kind} trigger (not drawn by this build)`;
}

/** One line for the list's actions column: "2 actions · create_task, notify".
 *  An action without a readable type shows as "?" — never a made-up name. */
export function actionsSummary(actions: unknown[]): string {
  if (actions.length === 0) return "no actions";
  const names = actions.map((action) => {
    if (isRecord(action) && typeof action.type === "string") return action.type;
    return "?";
  });
  return `${actions.length} action${actions.length === 1 ? "" : "s"} · ${names.join(", ")}`;
}

/** One line for the conditions column: "always" when empty — a rule without
 *  conditions fires on every trigger hit, and the words say so. */
export function conditionsSummary(conditions: unknown[]): string {
  if (conditions.length === 0) return "always";
  return `${conditions.length} condition${conditions.length === 1 ? "" : "s"}`;
}

export interface ConditionOutcomeView {
  path: string;
  op: string;
  passed: boolean;
}

/** One per-condition outcome of a run row — null when the shape is not the
 *  worker's ConditionOutcome; the cell falls back to raw JSON then. */
export function parseConditionOutcome(raw: unknown): ConditionOutcomeView | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.path !== "string" || typeof raw.op !== "string" || typeof raw.passed !== "boolean") {
    return null;
  }
  return { path: raw.path, op: raw.op, passed: raw.passed };
}

export interface ActionResultView {
  type: string;
  status: string;
  ref: string | null;
  error: string | null;
}

/** One per-action result of a run row — null when not drawable. */
export function parseActionResult(raw: unknown): ActionResultView | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.type !== "string" || typeof raw.status !== "string") return null;
  return {
    type: raw.type,
    status: raw.status,
    ref: typeof raw.ref === "string" ? raw.ref : null,
    error: typeof raw.error === "string" ? raw.error : null,
  };
}

export interface AutomationsFilters {
  query: string;
  kind: "all" | "event" | "due";
  state: "all" | "enabled" | "paused";
}

/** The list's filter — name or description text, trigger kind, on/off state.
 *  A rule whose trigger kind this build does not know shows under "all"
 *  only; the filter never pretends to have judged it. */
export function filterRules(rules: AutomationRuleRow[], filters: AutomationsFilters): AutomationRuleRow[] {
  const query = filters.query.trim().toLowerCase();
  return rules.filter((rule) => {
    if (filters.kind !== "all" && triggerKind(rule.trigger) !== filters.kind) return false;
    if (filters.state === "enabled" && !rule.enabled) return false;
    if (filters.state === "paused" && rule.enabled) return false;
    if (query === "") return true;
    return (
      rule.name.toLowerCase().includes(query) ||
      (rule.description ?? "").toLowerCase().includes(query)
    );
  });
}

// ---------------------------------------------------------------------------
// The spec editor's draft model. Every input is a string until submit turns
// it into the typed spec; shapes this build has no structured editor for
// stay raw JSON through the round trip, so editing an old rule never
// silently destroys what the operator cannot see a form for.
// ---------------------------------------------------------------------------

export type DueDirection = "before" | "after";

export type TriggerDraft =
  | { kind: "event"; action: string }
  | { kind: "due"; subjectType: string; anchorField: string; direction: DueDirection; offsetMinutes: string }
  | { kind: "json"; json: string };

export type ActionDraft =
  | { type: "create_task"; title: string; description: string; assigneeId: string; dueInHours: string }
  | { type: "notify"; userIdsText: string; title: string; body: string }
  | { type: "send_email"; userIdsText: string; subject: string; body: string }
  | { type: "json"; json: string };

export const CONDITION_OPS = ["eq", "ne", "in", "exists"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export interface ConditionDraft {
  path: string;
  op: ConditionOp;
  // The value as authored: JSON text for eq/ne/in, "true"/"false" for exists.
  value: string;
}

export interface SpecDraft {
  trigger: TriggerDraft;
  conditions: ConditionDraft[];
  actions: ActionDraft[];
}

export function emptyConditionDraft(): ConditionDraft {
  return { path: "", op: "eq", value: "" };
}

export function emptyActionDraft(): ActionDraft {
  return { type: "create_task", title: "", description: "", assigneeId: "", dueInHours: "" };
}

export function emptySpecDraft(): SpecDraft {
  return {
    trigger: { kind: "event", action: "" },
    conditions: [],
    actions: [emptyActionDraft()],
  };
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function conditionToDraft(raw: unknown): ConditionDraft {
  if (!isRecord(raw)) return emptyConditionDraft();
  const path = typeof raw.path === "string" ? raw.path : "";
  const op = CONDITION_OPS.find((candidate) => candidate === raw.op) ?? "eq";
  if (op === "exists") return { path, op, value: raw.value === true ? "true" : "false" };
  return { path, op, value: "value" in raw ? jsonText(raw.value) : "" };
}

function actionToDraft(raw: unknown): ActionDraft {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return { type: "json", json: isRecord(raw) || Array.isArray(raw) ? jsonText(raw) : "" };
  }
  const config = isRecord(raw.config) ? raw.config : {};
  if (raw.type === "create_task") {
    return {
      type: "create_task",
      title: typeof config.title === "string" ? config.title : "",
      description: typeof config.description === "string" ? config.description : "",
      assigneeId: typeof config.assigneeId === "string" ? config.assigneeId : "",
      dueInHours: typeof config.dueInHours === "number" ? String(config.dueInHours) : "",
    };
  }
  if (raw.type === "notify") {
    return {
      type: "notify",
      userIdsText: Array.isArray(config.userIds) ? config.userIds.map((id) => String(id)).join("\n") : "",
      title: typeof config.title === "string" ? config.title : "",
      body: typeof config.body === "string" ? config.body : "",
    };
  }
  if (raw.type === "send_email") {
    return {
      type: "send_email",
      userIdsText: Array.isArray(config.userIds) ? config.userIds.map((id) => String(id)).join("\n") : "",
      subject: typeof config.subject === "string" ? config.subject : "",
      body: typeof config.body === "string" ? config.body : "",
    };
  }
  // A type this build has no editor for keeps its JSON verbatim.
  return { type: "json", json: jsonText(raw) };
}

export function specToDraft(spec: { trigger: unknown; conditions: unknown; actions: unknown }): SpecDraft {
  let trigger: TriggerDraft;
  if (isRecord(spec.trigger) && spec.trigger.kind === "event" && typeof spec.trigger.action === "string") {
    trigger = { kind: "event", action: spec.trigger.action };
  } else if (
    isRecord(spec.trigger) &&
    spec.trigger.kind === "due" &&
    typeof spec.trigger.subjectType === "string" &&
    typeof spec.trigger.anchorField === "string" &&
    (spec.trigger.direction === "before" || spec.trigger.direction === "after") &&
    typeof spec.trigger.offsetMinutes === "number"
  ) {
    trigger = {
      kind: "due",
      subjectType: spec.trigger.subjectType,
      anchorField: spec.trigger.anchorField,
      direction: spec.trigger.direction,
      offsetMinutes: String(spec.trigger.offsetMinutes),
    };
  } else {
    trigger = { kind: "json", json: jsonText(spec.trigger) };
  }
  const conditions = Array.isArray(spec.conditions) ? spec.conditions.map(conditionToDraft) : [];
  const actions = Array.isArray(spec.actions) ? spec.actions.map(actionToDraft) : [];
  return { trigger, conditions, actions };
}

export type BuildResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function buildTrigger(draft: TriggerDraft): BuildResult<unknown> {
  if (draft.kind === "event") {
    const action = draft.action.trim();
    if (action === "") {
      return { ok: false, error: "The event trigger needs the audit action it fires on — e.g. task.created." };
    }
    return { ok: true, value: { kind: "event", action } };
  }
  if (draft.kind === "due") {
    const subjectType = draft.subjectType.trim();
    const anchorField = draft.anchorField.trim();
    const offset = Number(draft.offsetMinutes);
    if (subjectType === "") {
      return { ok: false, error: "The due trigger needs the record type it watches — e.g. task." };
    }
    if (anchorField === "") {
      return { ok: false, error: "The due trigger needs the date field it anchors on — e.g. dueAt." };
    }
    if (!Number.isInteger(offset) || offset < DUE_OFFSET_MIN || offset > DUE_OFFSET_MAX) {
      return {
        ok: false,
        error: `The offset must be whole minutes between ${DUE_OFFSET_MIN} and ${DUE_OFFSET_MAX} (90 days).`,
      };
    }
    return {
      ok: true,
      value: { kind: "due", subjectType, anchorField, direction: draft.direction, offsetMinutes: offset },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(draft.json);
  } catch {
    return { ok: false, error: "The trigger JSON is not valid JSON." };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: "The trigger JSON must be a JSON object with a kind." };
  }
  return { ok: true, value: parsed };
}

export function buildConditions(conditions: ConditionDraft[]): BuildResult<unknown[]> {
  const built: unknown[] = [];
  for (const condition of conditions) {
    const path = condition.path.trim();
    if (path === "") {
      return { ok: false, error: "Every condition needs a path into the event context — e.g. detail.to." };
    }
    if (condition.op === "exists") {
      if (condition.value !== "true" && condition.value !== "false") {
        return { ok: false, error: `The exists condition on ${path} must be true or false.` };
      }
      built.push({ path, op: "exists", value: condition.value === "true" });
      continue;
    }
    if (condition.value.trim() === "") {
      return { ok: false, error: `The ${condition.op} condition on ${path} needs a value as JSON — strings need quotes.` };
    }
    let value: unknown;
    try {
      value = JSON.parse(condition.value);
    } catch {
      return { ok: false, error: `The ${condition.op} condition on ${path} has a value that is not valid JSON.` };
    }
    if (condition.op === "in" && (!Array.isArray(value) || value.length === 0)) {
      return { ok: false, error: `The in condition on ${path} needs a non-empty JSON array.` };
    }
    built.push({ path, op: condition.op, value });
  }
  return { ok: true, value: built };
}

export function buildActions(drafts: ActionDraft[]): BuildResult<unknown[]> {
  const built: unknown[] = [];
  for (const draft of drafts) {
    if (draft.type === "create_task") {
      const title = draft.title.trim();
      if (title === "") {
        return { ok: false, error: "Every create-task action needs a title." };
      }
      const config: Record<string, unknown> = { title };
      if (draft.description.trim() !== "") config.description = draft.description.trim();
      if (draft.assigneeId.trim() !== "") config.assigneeId = draft.assigneeId.trim();
      if (draft.dueInHours.trim() !== "") {
        const hours = Number(draft.dueInHours);
        if (!Number.isInteger(hours) || hours < 1 || hours > 2160) {
          return { ok: false, error: "The due-in hours must be a whole number between 1 and 2160 (90 days)." };
        }
        config.dueInHours = hours;
      }
      built.push({ type: "create_task", config });
    } else if (draft.type === "notify") {
      const userIds = draft.userIdsText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      if (userIds.length === 0) {
        return { ok: false, error: "Every notify action needs at least one recipient id — one per line." };
      }
      const title = draft.title.trim();
      if (title === "") {
        return { ok: false, error: "Every notify action needs a title." };
      }
      const config: Record<string, unknown> = { userIds, title };
      if (draft.body.trim() !== "") config.body = draft.body.trim();
      built.push({ type: "notify", config });
    } else if (draft.type === "send_email") {
      const userIds = draft.userIdsText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      if (userIds.length === 0) {
        return { ok: false, error: "Every send-email action needs at least one recipient id — one per line. Recipients are in-app users; the mail goes to each account's email address." };
      }
      const subject = draft.subject.trim();
      if (subject === "") {
        return { ok: false, error: "Every send-email action needs a subject." };
      }
      const body = draft.body.trim();
      if (body === "") {
        return { ok: false, error: "Every send-email action needs a body." };
      }
      built.push({ type: "send_email", config: { userIds, subject, body } });
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(draft.json);
      } catch {
        return { ok: false, error: "One action's JSON is not valid JSON." };
      }
      if (!isRecord(parsed)) {
        return { ok: false, error: "An action must be a JSON object with a type." };
      }
      built.push(parsed);
    }
  }
  return { ok: true, value: built };
}

export function buildSpec(
  draft: SpecDraft,
): BuildResult<RuleSpecValue> {
  const trigger = buildTrigger(draft.trigger);
  if (!trigger.ok) return trigger;
  const conditions = buildConditions(draft.conditions);
  if (!conditions.ok) return conditions;
  const actions = buildActions(draft.actions);
  if (!actions.ok) return actions;
  return { ok: true, value: { trigger: trigger.value, conditions: conditions.value, actions: actions.value } };
}

/** The create form's identity draft — name/description are separate from the
 *  spec because the server takes them at the top level, not inside spec. */
export interface IdentityDraft {
  name: string;
  description: string;
}

export function buildDescription(description: string): string | null {
  const text = description.trim();
  return text === "" ? null : text;
}
