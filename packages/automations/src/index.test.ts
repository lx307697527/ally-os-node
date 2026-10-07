import { describe, expect, it } from "vitest";
import {
  AUTOMATION_ACTOR_PREFIX,
  dueEventContext,
  evaluateConditions,
  eventMatchesTrigger,
  resolvePath,
  ruleSpecSchema,
  subjectIdFromTarget,
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

  it("accepts a send_email action addressed to internal users", () => {
    const parsed = ruleSpecSchema.safeParse({
      trigger: { kind: "event", action: "approval.completed" },
      actions: [
        {
          type: "send_email",
          config: {
            userIds: ["6c1f7e2a-1d6e-4a7b-9c3d-2e5f8a9b0c1d"],
            subject: "审批已完成",
            body: "你关注的审批已通过。",
          },
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a send_email action with bad recipients or empty subject/body", () => {
    const base = { trigger: { kind: "event", action: "x" } };
    const action = (config: unknown) => [{ type: "send_email", config }];
    expect(
      ruleSpecSchema.safeParse({ ...base, actions: action({ userIds: [], subject: "s", body: "b" }) }).success,
    ).toBe(false);
    expect(
      ruleSpecSchema.safeParse({ ...base, actions: action({ userIds: ["not-a-uuid"], subject: "s", body: "b" }) })
        .success,
    ).toBe(false);
    expect(
      ruleSpecSchema.safeParse({ ...base, actions: action({ userIds: ["6c1f7e2a-1d6e-4a7b-9c3d-2e5f8a9b0c1d"], subject: "", body: "b" }) })
        .success,
    ).toBe(false);
    expect(
      ruleSpecSchema.safeParse({ ...base, actions: action({ userIds: ["6c1f7e2a-1d6e-4a7b-9c3d-2e5f8a9b0c1d"], subject: "s" }) })
        .success,
    ).toBe(false);
    expect(
      ruleSpecSchema.safeParse({ ...base, actions: action({ userIds: ["6c1f7e2a-1d6e-4a7b-9c3d-2e5f8a9b0c1d"], subject: "s", body: "   " }) })
        .success,
    ).toBe(false);
  });

  it("accepts a send_webhook action to a public https host, method defaults to POST", () => {
    const parsed = ruleSpecSchema.safeParse({
      trigger: { kind: "event", action: "approval.completed" },
      actions: [
        {
          type: "send_webhook",
          config: {
            url: "https://hooks.example.com/services/ally/123",
            headers: { authorization: "Bearer secret-token", "x-ally-rule": "approval-done" },
            body: { event: "approval.completed", id: "a-1" },
          },
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const action = parsed.data.actions[0];
      expect(
        action?.type === "send_webhook" ? action.config.method : undefined,
      ).toBe("POST");
    }
  });

  it("accepts PUT/PATCH methods and public IPv6 literals", () => {
    const parse = (config: Record<string, unknown>) =>
      ruleSpecSchema.safeParse({
        trigger: { kind: "event", action: "x" },
        actions: [{ type: "send_webhook", config: { url: "https://example.com/hook", ...config } }],
      });
    expect(parse({ method: "PUT" }).success).toBe(true);
    expect(parse({ method: "PATCH" }).success).toBe(true);
    expect(parse({ url: "https://[2606:4700::6810:85e5]/hook", method: "POST" }).success).toBe(true);
  });

  it("rejects a send_webhook action whose url is not https or points at a private host", () => {
    const parse = (url: string) =>
      ruleSpecSchema.safeParse({
        trigger: { kind: "event", action: "x" },
        actions: [{ type: "send_webhook", config: { url } }],
      });
    // 明文 http 不过闸：负载可能带密钥，出站一律加密
    expect(parse("http://hooks.example.com/hook").success).toBe(false);
    // 回环与本机名
    expect(parse("https://localhost/hook").success).toBe(false);
    expect(parse("https://sub.localhost/hook").success).toBe(false);
    expect(parse("https://127.0.0.1/hook").success).toBe(false);
    expect(parse("https://[::1]/hook").success).toBe(false);
    expect(parse("https://[::]/hook").success).toBe(false);
    // 私网段（RFC1918、CGNAT、链路本地含云元数据、ULA、基准测试、0/8）
    expect(parse("https://10.1.2.3/hook").success).toBe(false);
    expect(parse("https://172.16.0.9/hook").success).toBe(false);
    expect(parse("https://172.31.255.1/hook").success).toBe(false);
    expect(parse("https://192.168.1.1/hook").success).toBe(false);
    expect(parse("https://100.64.0.1/hook").success).toBe(false);
    expect(parse("https://169.254.169.254/latest/meta-data/").success).toBe(false);
    expect(parse("https://[fc00::1]/hook").success).toBe(false);
    expect(parse("https://[fd12:3456::1]/hook").success).toBe(false);
    expect(parse("https://[fe80::1]/hook").success).toBe(false);
    expect(parse("https://[::ffff:10.0.0.5]/hook").success).toBe(false);
    expect(parse("https://198.18.0.1/hook").success).toBe(false);
    expect(parse("https://0.0.0.0/hook").success).toBe(false);
    // mDNS / 内部解析域
    expect(parse("https://printer.local/hook").success).toBe(false);
    expect(parse("https://db.internal/hook").success).toBe(false);
    // 垃圾 url
    expect(parse("not a url").success).toBe(false);
    expect(parse("ftp://hooks.example.com/hook").success).toBe(false);
    // url 是唯一必填:缺了就拒
    expect(
      ruleSpecSchema.safeParse({
        trigger: { kind: "event", action: "x" },
        actions: [{ type: "send_webhook", config: {} }],
      }).success,
    ).toBe(false);
    // WHATWG URL 的 IPv4 规范化:十六进制/缩写变体落成点分十进制后照样过闸
    expect(parse("https://0x7f000001/hook").success).toBe(false);
    expect(parse("https://2130706433/hook").success).toBe(false);
  });

  it("rejects send_webhook headers with injection-shaped values, bad names, or more than ten", () => {
    const parse = (headers: unknown) =>
      ruleSpecSchema.safeParse({
        trigger: { kind: "event", action: "x" },
        actions: [{ type: "send_webhook", config: { url: "https://hooks.example.com/hook", headers } }],
      });
    // 值里带 CR/LF/NUL = 头部注入
    expect(parse({ "x-ok": "value\r\nX-Evil: injected" }).success).toBe(false);
    expect(parse({ "x-ok": "line1\nline2" }).success).toBe(false);
    expect(parse({ "x-ok": "null\u0000byte" }).success).toBe(false);
    // 名字必须是 RFC 7230 token:冒号、空格、控制字符进不了
    expect(parse({ "x: y": "v" }).success).toBe(false);
    expect(parse({ "bad name": "v" }).success).toBe(false);
    expect(parse({ "": "v" }).success).toBe(false);
    // 值长上界 1024
    expect(parse({ "x-long": "a".repeat(1025) }).success).toBe(false);
    expect(parse({ "x-ok": "a".repeat(1024) }).success).toBe(true);
    // 最多 10 个头
    const eleven = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`x-h${i}`, "v"]));
    expect(parse(eleven).success).toBe(false);
  });

  it("rejects a send_webhook action with an unknown method", () => {
    const parse = (method: string) =>
      ruleSpecSchema.safeParse({
        trigger: { kind: "event", action: "x" },
        actions: [{ type: "send_webhook", config: { url: "https://hooks.example.com/hook", method } }],
      });
    expect(parse("GET").success).toBe(false);
    expect(parse("DELETE").success).toBe(false);
    // 出站 webhook 是写语义的调用,读方法不属于这个动作
    expect(parse("post").success).toBe(false);
  });
});

describe("AUTOMATION_ACTOR_PREFIX", () => {
  it("is the loop-guard marker the scanner filters on", () => {
    expect(`${AUTOMATION_ACTOR_PREFIX}run-1`.startsWith(AUTOMATION_ACTOR_PREFIX)).toBe(true);
  });
});

describe("update_field action schema", () => {
  const parse = (action: unknown) =>
    ruleSpecSchema.safeParse({
      trigger: { kind: "event", action: "x" },
      actions: [action],
    });

  it("accepts a well-formed action with any JSON value (null included)", () => {
    expect(
      parse({ type: "update_field", config: { subjectType: "task", field: "status", value: "done" } })
        .success,
    ).toBe(true);
    expect(
      parse({ type: "update_field", config: { subjectType: "task", field: "dueAt", value: null } })
        .success,
    ).toBe(true);
    expect(
      parse({
        type: "update_field",
        config: { subjectType: "task", field: "flags", value: { nested: [1, "two"] } },
      }).success,
    ).toBe(true);
  });

  it("requires subjectType, field, and an explicit value (missing value key is refused, null is not)", () => {
    expect(parse({ type: "update_field", config: { field: "status", value: "done" } }).success).toBe(
      false,
    );
    expect(parse({ type: "update_field", config: { subjectType: "task", value: "done" } }).success).toBe(
      false,
    );
    // value 键缺席 = 作者忘了写目标值,不是「清空」——显式 null 才是
    expect(parse({ type: "update_field", config: { subjectType: "task", field: "status" } }).success).toBe(
      false,
    );
    expect(parse({ type: "update_field", config: { subjectType: "", field: "status", value: 1 } }).success).toBe(
      false,
    );
    expect(parse({ type: "update_field", config: { subjectType: "task", field: "", value: 1 } }).success).toBe(
      false,
    );
  });
});

describe("subjectIdFromTarget", () => {
  it("resolves a bare audit target as the subject id of the configured type", () => {
    expect(subjectIdFromTarget("018f3c7e-1", "task")).toEqual({ ok: true, subjectId: "018f3c7e-1" });
  });

  it("strips the matching due-style prefix", () => {
    expect(subjectIdFromTarget("task:abc-123", "task")).toEqual({ ok: true, subjectId: "abc-123" });
  });

  it("refuses a different subject's prefix — the rule author aimed update_field at the wrong object", () => {
    expect(subjectIdFromTarget("appointment:abc-123", "task")).toEqual({
      ok: false,
      reason: "target belongs to a different subject than task",
    });
  });

  it("refuses a prefix with no id after it", () => {
    expect(subjectIdFromTarget("task:", "task").ok).toBe(false);
  });

  it("refuses a missing or empty target", () => {
    expect(subjectIdFromTarget(null, "task").ok).toBe(false);
    expect(subjectIdFromTarget("", "task").ok).toBe(false);
  });
});
