// The automations adapters' contracts, against a fake fetch — same discipline
// as rules-client.test.ts: reads report the failure mode instead of flattening
// it, every parse is zod, history and rollback speak the ledger's rejections,
// and the display/build helpers stay liberal where the server stays strict —
// an unknown trigger or action shape round-trips as verbatim JSON, never as
// an invented form.
import { describe, expect, it, vi } from "vitest";

import {
  actionsSummary,
  buildActions,
  buildConditions,
  buildDescription,
  buildSpec,
  buildTrigger,
  conditionsSummary,
  createAutomationsAdapters,
  emptySpecDraft,
  filterRules,
  formatOffset,
  parseActionResult,
  parseConditionOutcome,
  specToDraft,
  triggerKind,
  triggerSummary,
  type AutomationRuleRow,
} from "./automations-client.ts";

function fetchJson(body: unknown, status = 200): typeof fetch {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

function fetchFailing(): typeof fetch {
  return vi.fn(() => Promise.reject(new Error("network down")));
}

/** A builder refused with the words we meant — assert ok=false first so the
 *  error branch narrows, instead of pushing `any` matchers into toEqual. */
function expectError(
  result: { ok: true; value: unknown } | { ok: false; error: string },
  pattern: RegExp,
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toMatch(pattern);
}

const RULE: AutomationRuleRow = {
  id: "b692d0d1-59a3-4a1e-9a5a-0b6f3f7c1a01",
  name: "Stage B entry follow-up",
  description: "Classic Odoo-style chain: enter stage → task + notify",
  trigger: { kind: "event", action: "workflow.state_changed" },
  conditions: [{ path: "detail.to", op: "eq", value: "stage_b" }],
  actions: [
    { type: "create_task", config: { title: "Follow up", dueInHours: 48 } },
    { type: "notify", config: { userIds: ["id-a"], title: "Stage B" } },
  ],
  enabled: true,
  version: 3,
  createdById: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-06T00:00:00.000Z",
};

const RUN = {
  id: "0f0f0f0f-59a3-4a1e-9a5a-0b6f3f7c1a02",
  ruleId: RULE.id,
  ruleName: RULE.name,
  sourceEventId: "11111111-59a3-4a1e-9a5a-0b6f3f7c1a03",
  status: "skipped",
  conditionResults: [{ path: "detail.to", op: "eq", passed: false }],
  actionResults: null,
  error: null,
  createdAt: "2026-10-06T00:00:00.000Z",
  finishedAt: "2026-10-06T00:00:01.000Z",
};

describe("automations adapters (#224 config face)", () => {
  it("list: parses the rules page; 403 is forbidden, network down is unavailable", async () => {
    const ok = createAutomationsAdapters(fetchJson({ rules: [RULE] }));
    expect(await ok.list()).toEqual({ ok: true, data: [RULE] });

    const forbidden = createAutomationsAdapters(fetchJson({}, 403));
    expect(await forbidden.list()).toEqual({ ok: false, reason: "forbidden" });

    const unavailable = createAutomationsAdapters(fetchFailing());
    expect(await unavailable.list()).toEqual({ ok: false, reason: "unavailable" });

    const unparseable = createAutomationsAdapters(fetchJson({ rules: "not-an-array" }));
    expect(await unparseable.list()).toEqual({ ok: false, reason: "unavailable" });
  });

  it("runs: builds the query string and parses the page", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ runs: [RUN] }), { status: 200 })),
    ) as unknown as typeof fetch;
    const adapters = createAutomationsAdapters(fetchFn);
    const result = await adapters.runs({ ruleId: RULE.id, status: "skipped", limit: 10 });
    expect(result).toEqual({ ok: true, data: [RUN] });
    const [url] = vi.mocked(fetchFn).mock.calls[0] as [string];
    expect(url).toBe(`/api/automations/runs?ruleId=${RULE.id}&status=skipped&limit=10`);

    const bareFn = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ runs: [] }), { status: 200 })),
    ) as unknown as typeof fetch;
    const bare = createAutomationsAdapters(bareFn);
    await bare.runs({});
    const [bareUrl] = vi.mocked(bareFn).mock.calls[0] as [string];
    expect(bareUrl).toBe("/api/automations/runs");
  });

  it("create: posts the spec at the top level; description omitted when empty", async () => {
    const payload = JSON.stringify({
      name: "New rule",
      trigger: { kind: "event", action: "task.created" },
      conditions: [],
      actions: [{ type: "create_task", config: { title: "Hi" } }],
    });
    const fetchFn = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ id: RULE.id }), { status: 201 })),
    ) as unknown as typeof fetch;
    const adapters = createAutomationsAdapters(fetchFn);
    const result = await adapters.create({
      name: "New rule",
      spec: {
        trigger: { kind: "event", action: "task.created" },
        conditions: [],
        actions: [{ type: "create_task", config: { title: "Hi" } }],
      },
    });
    expect(result).toEqual({ ok: true, data: { id: RULE.id } });
    const [url, init] = vi.mocked(fetchFn).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/automations");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(payload);

    const rejected = createAutomationsAdapters(fetchJson({ error: "invalid_request" }, 400));
    expect(await rejected.create({ name: "x", spec: { trigger: {}, conditions: [], actions: [] } })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("update: nests the spec, passes cleared description as null, reports 404", async () => {
    const spec = {
      trigger: { kind: "due", subjectType: "task", anchorField: "dueAt", direction: "before", offsetMinutes: 60 },
      conditions: [],
      actions: [{ type: "notify", config: { userIds: ["id-a"], title: "Due soon" } }],
    };
    const fetchFn = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ version: 4 }), { status: 200 })),
    ) as unknown as typeof fetch;
    const adapters = createAutomationsAdapters(fetchFn);
    const result = await adapters.update(RULE.id, {
      name: "Renamed",
      description: null,
      enabled: false,
      spec,
    });
    expect(result).toEqual({ ok: true, data: { version: 4 } });
    const [url, init] = vi.mocked(fetchFn).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/automations/${RULE.id}`);
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(
      JSON.stringify({ name: "Renamed", description: null, enabled: false, spec }),
    );

    const missing = createAutomationsAdapters(fetchJson({ error: "not_found" }, 404));
    expect(await missing.update(RULE.id, { enabled: true })).toEqual({ ok: false, reason: "not_found" });
  });

  it("remove: 404 is not_found, 200 is ok", async () => {
    const ok = createAutomationsAdapters(fetchJson({ ok: true }));
    expect(await ok.remove(RULE.id)).toEqual({ ok: true });

    const missing = createAutomationsAdapters(fetchJson({ error: "not_found" }, 404));
    expect(await missing.remove(RULE.id)).toEqual({ ok: false, reason: "not_found" });
  });

  it("history and rollback speak the ledger's rejections", async () => {
    const ledger = {
      subjectType: "automation_rule",
      subjectId: RULE.id,
      revisions: [
        { version: 1, source: "created", changes: [], changedById: null, createdAt: "2026-10-01T00:00:00.000Z" },
      ],
    };
    const adapters = createAutomationsAdapters(fetchJson(ledger));
    expect(await adapters.history(RULE.id)).toEqual({ ok: true, data: ledger.revisions });

    const rolledBack = createAutomationsAdapters(
      fetchJson({ subjectType: "automation_rule", subjectId: RULE.id, restoredVersion: 1, newVersion: 4, changes: [] }),
    );
    const rollback = await rolledBack.rollback(RULE.id, 1, "restore");
    expect(rollback).toEqual({
      ok: true,
      data: { subjectType: "automation_rule", subjectId: RULE.id, restoredVersion: 1, newVersion: 4, changes: [] },
    });

    const noChange = createAutomationsAdapters(fetchJson({ error: "rollback_no_change" }, 409));
    expect(await noChange.rollback(RULE.id, 3)).toEqual({ ok: false, reason: "no_change" });

    const unsupported = createAutomationsAdapters(fetchJson({ error: "rollback_unsupported" }, 409));
    expect(await unsupported.rollback(RULE.id, 1)).toEqual({ ok: false, reason: "unsupported" });
  });
});

describe("spec display helpers (#224)", () => {
  it("formatOffset renders minutes, hours, days", () => {
    expect(formatOffset(5)).toBe("5 min");
    expect(formatOffset(45)).toBe("45 min");
    expect(formatOffset(60)).toBe("1 h");
    expect(formatOffset(1440)).toBe("1 d");
    expect(formatOffset(129_600)).toBe("90 d");
  });

  it("triggerSummary draws known shapes and names unknown kinds honestly", () => {
    expect(triggerSummary({ kind: "event", action: "task.created" })).toBe("event · task.created");
    expect(triggerSummary({ kind: "due", subjectType: "task", anchorField: "dueAt", direction: "before", offsetMinutes: 90 })).toBe(
      "due · task.dueAt before 90 min",
    );
    expect(triggerSummary({ kind: "webhook", url: "https://…" })).toBe("webhook trigger (not drawn by this build)");
    expect(triggerSummary({ noKind: true })).toBe("Unreadable trigger");
    expect(triggerSummary("not-an-object")).toBe("Unreadable trigger");
    expect(triggerKind({ kind: "due" })).toBe("due");
    expect(triggerKind(null)).toBeNull();
  });

  it("actions and conditions summarize without inventing shapes", () => {
    expect(actionsSummary([])).toBe("no actions");
    expect(actionsSummary([{ type: "create_task", config: {} }])).toBe("1 action · create_task");
    expect(actionsSummary([{ type: "notify", config: {} }, { type: "webhook", config: {} }])).toBe(
      "2 actions · notify, webhook",
    );
    expect(actionsSummary([{ notAType: true }])).toBe("1 action · ?");
    expect(conditionsSummary([])).toBe("always");
    expect(conditionsSummary([{}, {}])).toBe("2 conditions");
  });

  it("run-row parsers accept the worker's shapes and reject everything else", () => {
    expect(parseConditionOutcome({ path: "detail.to", op: "eq", passed: true })).toEqual({
      path: "detail.to",
      op: "eq",
      passed: true,
    });
    expect(parseConditionOutcome({ path: "detail.to", op: "eq" })).toBeNull();
    expect(parseActionResult({ type: "create_task", status: "succeeded", ref: "task-1" })).toEqual({
      type: "create_task",
      status: "succeeded",
      ref: "task-1",
      error: null,
    });
    expect(parseActionResult("junk")).toBeNull();
  });

  it("filterRules: query, trigger kind and on/off state", () => {
    const pausedDue: AutomationRuleRow = { ...RULE, id: "other", name: "Due watch", description: null, enabled: false, trigger: { kind: "due", subjectType: "task", anchorField: "dueAt", direction: "before", offsetMinutes: 60 } };
    const rules = [RULE, pausedDue];
    expect(filterRules(rules, { query: "stage", kind: "all", state: "all" })).toEqual([RULE]);
    expect(filterRules(rules, { query: "", kind: "due", state: "all" })).toEqual([pausedDue]);
    expect(filterRules(rules, { query: "", kind: "all", state: "paused" })).toEqual([pausedDue]);
    expect(filterRules(rules, { query: "", kind: "all", state: "enabled" })).toEqual([RULE]);
    expect(filterRules(rules, { query: "nomatch", kind: "all", state: "all" })).toEqual([]);
  });
});

describe("spec draft round trip (#224)", () => {
  it("empty draft: event trigger, no conditions, one create_task action", () => {
    const draft = emptySpecDraft();
    expect(draft.trigger).toEqual({ kind: "event", action: "" });
    expect(draft.conditions).toEqual([]);
    expect(draft.actions).toHaveLength(1);
  });

  it("specToDraft: known shapes come back structured", () => {
    const draft = specToDraft({
      trigger: { kind: "due", subjectType: "task", anchorField: "dueAt", direction: "after", offsetMinutes: 45 },
      conditions: [
        { path: "detail.to", op: "eq", value: "stage_b" },
        { path: "actor", op: "exists", value: true },
      ],
      actions: [
        { type: "create_task", config: { title: "Hi", dueInHours: 24 } },
        { type: "notify", config: { userIds: ["id-a", "id-b"], title: "Hello", body: "World" } },
      ],
    });
    expect(draft.trigger).toEqual({ kind: "due", subjectType: "task", anchorField: "dueAt", direction: "after", offsetMinutes: "45" });
    expect(draft.conditions).toEqual([
      { path: "detail.to", op: "eq", value: '"stage_b"' },
      { path: "actor", op: "exists", value: "true" },
    ]);
    expect(draft.actions[0]).toEqual({ type: "create_task", title: "Hi", description: "", assigneeId: "", dueInHours: "24" });
    expect(draft.actions[1]).toEqual({ type: "notify", userIdsText: "id-a\nid-b", title: "Hello", body: "World" });
  });

  it("specToDraft: unknown shapes keep their JSON verbatim — saving an old rule cannot destroy them", () => {
    const webhook = { type: "webhook", config: { url: "https://example.com/hook", secret: "s" } };
    const draft = specToDraft({
      trigger: { kind: "cron", expression: "*/5 * * * *" },
      conditions: [{ path: "detail.x", op: "eq", value: 7 }],
      actions: [webhook, { type: "notify", config: { userIds: ["id-a"], title: "t" } }],
    });
    expect(draft.trigger).toEqual({ kind: "json", json: JSON.stringify({ kind: "cron", expression: "*/5 * * * *" }, null, 2) });
    expect(draft.actions[0]).toEqual({ type: "json", json: JSON.stringify(webhook, null, 2) });
  });

  it("buildTrigger: event, due bounds, json passthrough", () => {
    expect(buildTrigger({ kind: "event", action: " task.created " })).toEqual({
      ok: true,
      value: { kind: "event", action: "task.created" },
    });
    expectError(buildTrigger({ kind: "event", action: " " }), /needs the audit action/);
    expectError(
      buildTrigger({ kind: "due", subjectType: "task", anchorField: "dueAt", direction: "before", offsetMinutes: "4" }),
      /between 5 and 129600/,
    );
    expectError(
      buildTrigger({ kind: "due", subjectType: "task", anchorField: "dueAt", direction: "before", offsetMinutes: "129601" }),
      /between 5 and 129600/,
    );
    expect(
      buildTrigger({ kind: "due", subjectType: "task", anchorField: "dueAt", direction: "before", offsetMinutes: "90" }),
    ).toEqual({
      ok: true,
      value: { kind: "due", subjectType: "task", anchorField: "dueAt", direction: "before", offsetMinutes: 90 },
    });
    expectError(
      buildTrigger({ kind: "due", subjectType: "", anchorField: "dueAt", direction: "before", offsetMinutes: "90" }),
      /record type/,
    );
    expectError(buildTrigger({ kind: "json", json: "{not json" }), /not valid JSON/);
    expectError(buildTrigger({ kind: "json", json: "[1,2]" }), /JSON object/);
    expect(buildTrigger({ kind: "json", json: '{"kind":"custom","x":1}' })).toEqual({
      ok: true,
      value: { kind: "custom", x: 1 },
    });
  });

  it("buildConditions: per-op value shapes, fail loud per row", () => {
    expect(buildConditions([{ path: "detail.to", op: "eq", value: '"b"' }])).toEqual({
      ok: true,
      value: [{ path: "detail.to", op: "eq", value: "b" }],
    });
    expect(buildConditions([{ path: "actor", op: "exists", value: "true" }])).toEqual({
      ok: true,
      value: [{ path: "actor", op: "exists", value: true }],
    });
    expectError(buildConditions([{ path: "actor", op: "exists", value: "yes" }]), /true or false/);
    expectError(buildConditions([{ path: "detail.to", op: "in", value: '{"a":1}' }]), /non-empty JSON array/);
    expectError(buildConditions([{ path: "detail.to", op: "eq", value: "bare" }]), /not valid JSON/);
    expectError(buildConditions([{ path: " ", op: "eq", value: "1" }]), /needs a path/);
  });

  it("buildActions: create_task and notify build configs; bounds fail loud", () => {
    expect(
      buildActions([
        { type: "create_task", title: "Follow up", description: "Check in", assigneeId: "id-a", dueInHours: "48" },
      ]),
    ).toEqual({
      ok: true,
      value: [
        { type: "create_task", config: { title: "Follow up", description: "Check in", assigneeId: "id-a", dueInHours: 48 } },
      ],
    });
    expectError(
      buildActions([{ type: "create_task", title: "x", description: "", assigneeId: "", dueInHours: "0" }]),
      /between 1 and 2160/,
    );
    expect(
      buildActions([{ type: "notify", userIdsText: "id-a\nid-b", title: "Hello", body: "" }]),
    ).toEqual({
      ok: true,
      value: [{ type: "notify", config: { userIds: ["id-a", "id-b"], title: "Hello" } }],
    });
    expectError(buildActions([{ type: "notify", userIdsText: " ", title: "Hello", body: "" }]), /at least one recipient/);
    expectError(
      buildActions([{ type: "create_task", title: " ", description: "", assigneeId: "", dueInHours: "" }]),
      /needs a title/,
    );
  });

  it("buildActions: json passthrough keeps future types intact", () => {
    const webhook = JSON.stringify({ type: "webhook", config: { url: "https://example.com" } });
    expect(buildActions([{ type: "json", json: webhook }])).toEqual({
      ok: true,
      value: [{ type: "webhook", config: { url: "https://example.com" } }],
    });
    expectError(buildActions([{ type: "json", json: "[1]" }]), /JSON object/);
  });

  it("send_email: drafts structured, builds the config, and round-trips through the edit form", () => {
    const spec = {
      trigger: { kind: "event", action: "approval.completed" },
      conditions: [],
      actions: [
        { type: "send_email", config: { userIds: ["id-a", "id-b"], subject: "Approved", body: "It is done." } },
      ],
    };
    const draft = specToDraft(spec);
    expect(draft.actions[0]).toEqual({
      type: "send_email",
      userIdsText: "id-a\nid-b",
      subject: "Approved",
      body: "It is done.",
    });
    expect(buildActions(draft.actions)).toEqual({ ok: true, value: spec.actions });

    expectError(
      buildActions([{ type: "send_email", userIdsText: " ", subject: "s", body: "b" }]),
      /at least one recipient/,
    );
    expectError(
      buildActions([{ type: "send_email", userIdsText: "id-a", subject: " ", body: "b" }]),
      /needs a subject/,
    );
    expectError(
      buildActions([{ type: "send_email", userIdsText: "id-a", subject: "s", body: " " }]),
      /needs a body/,
    );
  });

  it("send_webhook: drafts structured, builds the config, and round-trips through the edit form", () => {
    const spec = {
      trigger: { kind: "event", action: "approval.completed" },
      conditions: [],
      actions: [
        {
          type: "send_webhook",
          config: {
            url: "https://hooks.example.com/services/ally/123",
            method: "POST",
            headers: { authorization: "Bearer tok_abc" },
            body: { event: "approval.completed" },
          },
        },
      ],
    };
    const draft = specToDraft(spec);
    expect(draft.actions[0]).toEqual({
      type: "send_webhook",
      url: "https://hooks.example.com/services/ally/123",
      method: "POST",
      headersText: "authorization: Bearer tok_abc",
      bodyText: JSON.stringify({ event: "approval.completed" }, null, 2),
    });
    expect(buildActions(draft.actions)).toEqual({ ok: true, value: spec.actions });

    // 无 headers / 无 body 的最小形状往返(method 缺省按 POST 处理)
    const minimal = specToDraft({
      trigger: { kind: "event", action: "x" },
      conditions: [],
      actions: [{ type: "send_webhook", config: { url: "https://hooks.example.com/hook", method: "PUT" } }],
    });
    expect(minimal.actions[0]).toEqual({
      type: "send_webhook",
      url: "https://hooks.example.com/hook",
      method: "PUT",
      headersText: "",
      bodyText: "",
    });
    expect(buildActions(minimal.actions)).toEqual({
      ok: true,
      value: [{ type: "send_webhook", config: { url: "https://hooks.example.com/hook", method: "PUT" } }],
    });

    expectError(
      buildActions([{ type: "send_webhook", url: " ", method: "POST", headersText: "", bodyText: "" }]),
      /needs an https URL/,
    );
    expectError(
      buildActions([{ type: "send_webhook", url: "https://example.com/h", method: "POST", headersText: "NoColon", bodyText: "" }]),
      /Name: Value/,
    );
    expectError(
      buildActions([{ type: "send_webhook", url: "https://example.com/h", method: "POST", headersText: "", bodyText: "{broken" }]),
      /not valid JSON/,
    );
  });

  it("buildSpec: composes the three builders; first failure wins", () => {
    const good = emptySpecDraft();
    good.trigger = { kind: "event", action: "task.created" };
    good.actions = [{ type: "create_task", title: "Hi", description: "", assigneeId: "", dueInHours: "" }];
    const built = buildSpec(good);
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.value).toEqual({
        trigger: { kind: "event", action: "task.created" },
        conditions: [],
        actions: [{ type: "create_task", config: { title: "Hi" } }],
      });
    }
    const broken = emptySpecDraft();
    broken.trigger = { kind: "event", action: "task.created" };
    broken.conditions = [{ path: "", op: "eq", value: "1" }];
    expectError(buildSpec(broken), /needs a path/);
  });

  it("buildDescription: empty clears to null, text trims", () => {
    expect(buildDescription("")).toBeNull();
    expect(buildDescription("  spaced  ")).toBe("spaced");
  });
});
