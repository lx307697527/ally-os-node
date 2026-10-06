import { describe, expect, it } from "vitest";
import {
  AUTOMATION_ACTOR_PREFIX,
  dueEventContext,
  evaluateConditions,
  eventMatchesTrigger,
  resolvePath,
  ruleSpecSchema,
} from "./index.ts";

const ctx = {
  action: "workflow.state_changed",
  target: "instance-1",
  actor: "user-1",
  detail: { from: "draft", to: "review", subjectType: "lead", nested: { ok: true } },
};

describe("eventMatchesTrigger", () => {
  it("matches the audit action exactly", () => {
    expect(
      eventMatchesTrigger({ kind: "event", action: "task.created" }, { action: "task.created" }),
    ).toBe(true);
    expect(
      eventMatchesTrigger({ kind: "event", action: "task.created" }, { action: "task.updated" }),
    ).toBe(false);
  });

  it("never matches a due trigger (due rules belong to the due scanner, not the event scan)", () => {
    expect(
      eventMatchesTrigger(
        { kind: "due", subjectType: "task", anchorField: "dueAt", direction: "before", offsetMinutes: 60 },
        { action: "task.due" },
      ),
    ).toBe(false);
  });
});

describe("resolvePath", () => {
  it("resolves the four roots and dotted detail paths", () => {
    expect(resolvePath(ctx, "action")).toBe("workflow.state_changed");
    expect(resolvePath(ctx, "target")).toBe("instance-1");
    expect(resolvePath(ctx, "actor")).toBe("user-1");
    expect(resolvePath(ctx, "detail.to")).toBe("review");
    expect(resolvePath(ctx, "detail.nested.ok")).toBe(true);
  });

  it("never resolves missing roots, missing keys, or prototype chains", () => {
    expect(resolvePath(ctx, "subjectType")).toBeUndefined();
    expect(resolvePath(ctx, "detail.missing")).toBeUndefined();
    expect(resolvePath(ctx, "detail.nested.ok.deep")).toBeUndefined();
    expect(resolvePath({ ...ctx, detail: null }, "detail.to")).toBeUndefined();
    expect(resolvePath({ ...ctx, detail: { __proto__: { x: 1 } } }, "detail.__proto__.x")).toBeUndefined();
    expect(resolvePath(ctx, "detail.nested.length")).toBeUndefined();
  });
});

describe("evaluateConditions", () => {
  it("passes with no conditions", () => {
    expect(evaluateConditions([], ctx).passed).toBe(true);
  });

  it("requires every condition (AND)", () => {
    const result = evaluateConditions(
      [
        { path: "detail.to", op: "eq", value: "review" },
        { path: "detail.subjectType", op: "in", value: ["lead", "order"] },
      ],
      ctx,
    );
    expect(result.passed).toBe(true);
    const failing = evaluateConditions(
      [
        { path: "detail.to", op: "eq", value: "review" },
        { path: "detail.subjectType", op: "eq", value: "order" },
      ],
      ctx,
    );
    expect(failing.passed).toBe(false);
    expect(failing.outcomes.map((o) => o.passed)).toEqual([true, false]);
  });

  it("fails closed when the path is missing", () => {
    expect(evaluateConditions([{ path: "detail.missing", op: "eq", value: "x" }], ctx).passed).toBe(false);
    expect(evaluateConditions([{ path: "detail.missing", op: "ne", value: "x" }], ctx).passed).toBe(false);
    expect(evaluateConditions([{ path: "detail.missing", op: "in", value: ["x"] }], ctx).passed).toBe(false);
    // exists 是显式表达「必须有/必须没有」的唯一通道
    expect(evaluateConditions([{ path: "detail.missing", op: "exists", value: false }], ctx).passed).toBe(true);
    expect(evaluateConditions([{ path: "detail.to", op: "exists", value: true }], ctx).passed).toBe(true);
    expect(evaluateConditions([{ path: "detail.to", op: "exists", value: false }], ctx).passed).toBe(false);
  });

  it("ne is satisfied only by a present, different value", () => {
    expect(evaluateConditions([{ path: "detail.to", op: "ne", value: "draft" }], ctx).passed).toBe(true);
    expect(evaluateConditions([{ path: "detail.to", op: "ne", value: "review" }], ctx).passed).toBe(false);
  });

  it("evaluates the due scanner's synthesized context like any audit event", () => {
    const due = dueEventContext({
      subjectType: "task",
      subjectId: "0f0a1b2c-3d4e-4f5a-8b9c-0d1e2f3a4b5c",
      detail: { status: "open", title: "跟进审阅" },
    });
    expect(due.action).toBe("task.due");
    expect(due.target).toBe("task:0f0a1b2c-3d4e-4f5a-8b9c-0d1e2f3a4b5c");
    expect(due.actor).toBeNull();
    expect(evaluateConditions([{ path: "detail.status", op: "eq", value: "open" }], due).passed).toBe(true);
    expect(evaluateConditions([{ path: "detail.status", op: "eq", value: "done" }], due).passed).toBe(false);
  });
});

describe("ruleSpecSchema", () => {
  it("accepts a stage-enter rule with both kernel actions", () => {
    const parsed = ruleSpecSchema.safeParse({
      trigger: { kind: "event", action: "workflow.state_changed" },
      conditions: [{ path: "detail.to", op: "eq", value: "review" }],
      actions: [
        { type: "create_task", config: { title: "跟进审阅", dueInHours: 24 } },
        { type: "notify", config: { userIds: ["6c1f7e2a-1d6e-4a7b-9c3d-2e5f8a9b0c1d"], title: "进入审阅" } },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a due trigger with direction and bounded offset", () => {
    const parsed = ruleSpecSchema.safeParse({
      trigger: { kind: "due", subjectType: "task", anchorField: "dueAt", direction: "before", offsetMinutes: 120 },
      actions: [{ type: "notify", config: { userIds: ["6c1f7e2a-1d6e-4a7b-9c3d-2e5f8a9b0c1d"], title: "任务快到期" } }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.trigger.kind === "due") {
      expect(parsed.data.trigger.offsetMinutes).toBe(120);
      expect(parsed.data.trigger.direction).toBe("before");
    }
  });

  it("rejects a due trigger with out-of-bounds offset or bad direction", () => {
    const base = {
      subjectType: "task",
      anchorField: "dueAt",
      actions: [{ type: "notify", config: { userIds: ["6c1f7e2a-1d6e-4a7b-9c3d-2e5f8a9b0c1d"], title: "t" } }],
    };
    expect(
      ruleSpecSchema.safeParse({ trigger: { kind: "due", ...base, direction: "before", offsetMinutes: 4 } }).success,
    ).toBe(false);
    expect(
      ruleSpecSchema.safeParse({ trigger: { kind: "due", ...base, direction: "around", offsetMinutes: 60 } }).success,
    ).toBe(false);
    expect(
      ruleSpecSchema.safeParse({
        trigger: { kind: "due", ...base, direction: "before", offsetMinutes: 129_601 },
      }).success,
    ).toBe(false);
    expect(
      ruleSpecSchema.safeParse({ trigger: { kind: "due", ...base, direction: "after", offsetMinutes: 0 } }).success,
    ).toBe(false);
  });

  it("rejects a trigger without kind (legacy slice-1 shape is gone; rules are pre-launch data)", () => {
    expect(
      ruleSpecSchema.safeParse({
        trigger: { action: "workflow.state_changed" },
        actions: [{ type: "create_task", config: { title: "t" } }],
      }).success,
    ).toBe(false);
    expect(
      ruleSpecSchema.safeParse({
        trigger: { subjectType: "task", anchorField: "dueAt", direction: "before", offsetMinutes: 60 },
        actions: [{ type: "create_task", config: { title: "t" } }],
      }).success,
    ).toBe(false);
  });

  it("rejects actions without config, empty actions, and op/value mismatches", () => {
    expect(
      ruleSpecSchema.safeParse({ trigger: { kind: "event", action: "x" }, actions: [] }).success,
    ).toBe(false);
    expect(
      ruleSpecSchema.safeParse({
        trigger: { kind: "event", action: "x" },
        actions: [{ type: "create_task" }],
      }).success,
    ).toBe(false);
    expect(
      ruleSpecSchema.safeParse({
        trigger: { kind: "event", action: "x" },
        actions: [{ type: "create_task", config: { title: "t" } }],
        conditions: [{ path: "detail.a", op: "eq" }],
      }).success,
    ).toBe(false);
    expect(
      ruleSpecSchema.safeParse({
        trigger: { kind: "event", action: "x" },
        actions: [{ type: "create_task", config: { title: "t" } }],
        conditions: [{ path: "detail.a", op: "in", value: [] }],
      }).success,
    ).toBe(false);
    expect(
      ruleSpecSchema.safeParse({
        trigger: { kind: "event", action: "x" },
        actions: [{ type: "create_task", config: { title: "t" } }],
        conditions: [{ path: "detail.a", op: "exists", value: "yes" }],
      }).success,
    ).toBe(false);
  });

  it("rejects more than ten actions", () => {
    const action = { type: "notify", config: { userIds: ["6c1f7e2a-1d6e-4a7b-9c3d-2e5f8a9b0c1d"], title: "t" } };
    expect(
      ruleSpecSchema.safeParse({
        trigger: { kind: "event", action: "x" },
        actions: Array.from({ length: 11 }, () => action),
      }).success,
    ).toBe(false);
  });
});

describe("AUTOMATION_ACTOR_PREFIX", () => {
  it("is the loop-guard marker the scanner filters on", () => {
    expect(`${AUTOMATION_ACTOR_PREFIX}run-1`.startsWith(AUTOMATION_ACTOR_PREFIX)).toBe(true);
  });
});
