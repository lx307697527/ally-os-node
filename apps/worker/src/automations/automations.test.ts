import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { REALTIME_LISTEN_CHANNEL, userChannel } from "@ally/realtime";
import type { ActionDeps } from "./actions.ts";
import { runAutomationRun } from "./runner.ts";
import { GIVE_UP_AFTER_SECONDS, RESEND_PENDING_AFTER_SECONDS, runAutomationScan } from "./scanner.ts";

// 集成测试：需要真实 PostgreSQL（规则/run/任务/通知行、事务与行锁、唯一约束
// 去重）。未设 DATABASE_URL 时跳过。本文件用独立临时库（每次运行新建、跑完
// drop，纪律同 tasks.test.ts）；pg-boss 不进场——sendRunJob/发布注入收集桩，
// 任务注册与投递链路由 runner.test.ts 与 CI 的真实 pg-boss 覆盖。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

const USERS = {
  creator: randomUUID(),
  assignee: randomUUID(),
  watcher: randomUUID(),
} as const;

function adminUrl(url: string | undefined): string {
  if (url === undefined) return "";
  const parsed = new URL(url);
  parsed.pathname = "/postgres";
  return parsed.toString();
}

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in test");
  return value;
}

describe.skipIf(!databaseUrl)("automation scan/run (#224 slice 1, integration)", () => {
  const dbName = `automations_worker_test_${String(Date.now())}_${String(process.pid)}`;
  const admin = createDb(adminUrl(databaseUrl));
  const scopedUrl =
    databaseUrl === undefined
      ? ""
      : (() => {
          const url = new URL(databaseUrl);
          url.pathname = `/${dbName}`;
          return url.toString();
        })();
  const { db, pool } = createDb(scopedUrl);
  pool.on("error", () => {});
  admin.pool.on("error", () => {});

  const sent: string[] = [];
  const notifyCalls: { text: string; values?: unknown[] | undefined }[] = [];

  const deps: ActionDeps = {
    db,
    publishExecutor: {
      query: (text, values) => {
        notifyCalls.push({ text, values });
        return Promise.resolve(undefined);
      },
    },
    logger,
    instanceId: "worker-test",
  };
  const sendRunJob = (runId: string): Promise<void> => {
    sent.push(runId);
    return Promise.resolve();
  };

  async function insertRule(values: {
    name: string;
    trigger: unknown;
    conditions?: unknown[];
    actions: unknown[];
    enabled?: boolean;
  }): Promise<string> {
    const inserted = await db
      .insert(schema.automationRules)
      .values({
        name: values.name,
        trigger: values.trigger as Record<string, unknown>,
        conditions: values.conditions ?? [],
        actions: values.actions,
        ...(values.enabled !== undefined ? { enabled: values.enabled } : {}),
        createdById: USERS.creator,
      })
      .returning({ id: schema.automationRules.id });
    return must(inserted[0]).id;
  }

  async function insertAuditEvent(values: {
    action: string;
    actor?: string | null;
    detail?: Record<string, unknown> | null;
  }): Promise<string> {
    const inserted = await db
      .insert(schema.auditEvents)
      .values({
        action: values.action,
        ...(values.actor !== undefined ? { actor: values.actor } : {}),
        ...(values.detail !== undefined ? { detail: values.detail } : {}),
      })
      .returning({ id: schema.auditEvents.id });
    return must(inserted[0]).id;
  }

  async function onlyRun(): Promise<{ id: string; status: string; error: string | null; actionResults: unknown }> {
    const rows = await db.select().from(schema.automationRuns);
    expect(rows).toHaveLength(1);
    const run = must(rows[0]);
    return { id: run.id, status: run.status, error: run.error, actionResults: run.actionResults };
  }

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
  });

  beforeEach(async () => {
    sent.length = 0;
    notifyCalls.length = 0;
    // 单语句 TRUNCATE：runs → rules、notifications/tasks → auth_user 都有 FK
    await db.execute(
      sql`truncate table ${schema.automationRuns}, ${schema.automationRules}, ${schema.tasks}, ${schema.notifications}, ${schema.auditEvents}, ${schema.authUser} cascade`,
    );
    await db.insert(schema.authUser).values(
      Object.entries(USERS).map(([name, id]) => ({
        id,
        name: name.charAt(0).toUpperCase() + name.slice(1),
        email: `${name}@example.com`,
        emailVerified: true,
      })),
    );
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}"`);
    await admin.pool.end();
  });

  it("end-to-end: stage-enter rule creates task and notifications from an audit event", async () => {
    const ruleId = await insertRule({
      name: "进入审阅自动跟进",
      trigger: { kind: "event", action: "workflow.state_changed" },
      conditions: [{ path: "detail.to", op: "eq", value: "review" }],
      actions: [
        {
          type: "create_task",
          config: { title: "跟进审阅", assigneeId: USERS.assignee, dueInHours: 24 },
        },
        { type: "notify", config: { userIds: [USERS.watcher], title: "有实例进入审阅" } },
      ],
    });
    await insertAuditEvent({
      action: "workflow.state_changed",
      actor: USERS.creator,
      detail: { to: "review", from: "draft", subjectType: "lead" },
    });

    await runAutomationScan({ ...deps, sendRunJob });
    const run = await onlyRun();
    expect(run.status).toBe("pending");
    expect(sent).toEqual([run.id]);

    await runAutomationRun(deps, { runId: run.id });
    const finishedRows = await db.select().from(schema.automationRuns);
    const finished = must(finishedRows[0]);
    expect(finished.status).toBe("succeeded");
    expect(finished.ruleId).toBe(ruleId);
    expect(finished.ruleName).toBe("进入审阅自动跟进");
    expect(finished.finishedAt).not.toBeNull();
    const results = finished.actionResults as { type: string; status: string; ref?: string }[];
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "succeeded")).toBe(true);

    // 任务：创建人 = 规则创建者、经办人、到期 = now + 24h（±1h 容差）；
    // 附着在规则行上（观测面 + due 触发的防环闸，见 actions.ts）
    const tasks = await db.select().from(schema.tasks);
    expect(tasks).toHaveLength(1);
    const task = must(tasks[0]);
    expect(task.title).toBe("跟进审阅");
    expect(task.assigneeId).toBe(USERS.assignee);
    expect(task.createdById).toBe(USERS.creator);
    expect(task.dueAt?.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(task.subjectType).toBe("automation_rule");
    expect(task.subjectId).toBe(ruleId);

    // 动作的审计带 automation 前缀 actor 与 via 标记（扫描器据此防回路）
    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "task.created"));
    expect(audits).toHaveLength(1);
    const audit = must(audits[0]);
    expect(audit.actor).toBe(`automation:${run.id}`);
    expect((audit.detail as { via?: string }).via).toBe("automation");

    // 通知：task.assigned 给经办人 + automation.notified 给 watcher
    const notifications = await db.select().from(schema.notifications);
    const types = notifications.map((n) => n.eventType).sort();
    expect(types).toEqual(["automation.notified", "task.assigned"]);

    // 铃铛「催」：pg_notify 总线帧，每人一帧
    expect(notifyCalls).toHaveLength(2);
    for (const call of notifyCalls) {
      expect(call.text).toBe("select pg_notify($1, $2)");
      expect(call.values?.[0]).toBe(REALTIME_LISTEN_CHANNEL);
    }
    const frames = notifyCalls.map((c) => String(c.values?.[1]));
    expect(frames.some((f) => f.includes(userChannel(USERS.assignee)))).toBe(true);
    expect(frames.some((f) => f.includes(userChannel(USERS.watcher)))).toBe(true);
  });

  it("conditions that fail produce a skipped run without a run job", async () => {
    await insertRule({
      name: "只进 review",
      trigger: { kind: "event", action: "workflow.state_changed" },
      conditions: [{ path: "detail.to", op: "eq", value: "review" }],
      actions: [{ type: "notify", config: { userIds: [USERS.watcher], title: "t" } }],
    });
    await insertAuditEvent({ action: "workflow.state_changed", detail: { to: "done" } });
    await runAutomationScan({ ...deps, sendRunJob });
    const run = await onlyRun();
    expect(run.status).toBe("skipped");
    expect((run.actionResults as { passed: boolean }[] | null) ?? null).toBeNull();
    expect(sent).toHaveLength(0);
    expect(await db.select().from(schema.tasks)).toHaveLength(0);
  });

  it("rescans are deduplicated by the (rule, event) unique constraint", async () => {
    await insertRule({
      name: "每次新建任务都通知",
      trigger: { kind: "event", action: "task.created" },
      actions: [{ type: "notify", config: { userIds: [USERS.watcher], title: "t" } }],
    });
    await insertAuditEvent({ action: "task.created", detail: {} });
    await runAutomationScan({ ...deps, sendRunJob });
    await runAutomationScan({ ...deps, sendRunJob });
    expect(await db.select().from(schema.automationRuns)).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("automation-produced audit events (automation: actor) never re-trigger rules", async () => {
    await insertRule({
      name: "回路试探",
      trigger: { kind: "event", action: "task.created" },
      actions: [{ type: "notify", config: { userIds: [USERS.watcher], title: "t" } }],
    });
    await insertAuditEvent({ action: "task.created", actor: `automation:${randomUUID()}` });
    await runAutomationScan({ ...deps, sendRunJob });
    expect(await db.select().from(schema.automationRuns)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("disabled rules do not match", async () => {
    await insertRule({
      name: "停用的规则",
      trigger: { kind: "event", action: "task.created" },
      actions: [{ type: "notify", config: { userIds: [USERS.watcher], title: "t" } }],
      enabled: false,
    });
    await insertAuditEvent({ action: "task.created", detail: {} });
    await runAutomationScan({ ...deps, sendRunJob });
    expect(await db.select().from(schema.automationRuns)).toHaveLength(0);
  });

  it("retries only the failed action and skips already-succeeded ones", async () => {
    const ruleId = await insertRule({
      name: "第二个动作会失败",
      trigger: { kind: "event", action: "task.created" },
      actions: [
        { type: "create_task", config: { title: "先建任务" } },
        // 收件人不存在 → FK 违反 → 动作失败（重试语境）
        { type: "notify", config: { userIds: [randomUUID()], title: "t" } },
      ],
    });
    await insertAuditEvent({ action: "task.created", detail: {} });
    await runAutomationScan({ ...deps, sendRunJob });
    const run = await onlyRun();

    // 第一次尝试：建任务成功、通知失败 → 抛错（pg-boss 重试），run 保持 pending
    await expect(runAutomationRun(deps, { runId: run.id })).rejects.toThrow(/automation action failed/);
    const afterFirst = await onlyRun();
    expect(afterFirst.status).toBe("pending");
    const firstResults = afterFirst.actionResults as { type: string; status: string }[];
    expect(firstResults).toHaveLength(2);
    expect(firstResults[0]).toMatchObject({ type: "create_task", status: "succeeded" });
    expect(firstResults[1]).toMatchObject({ type: "notify", status: "failed" });
    expect(await db.select().from(schema.tasks)).toHaveLength(1);

    // 第二次尝试仍失败（收件人还是不存在）：不重复建任务
    await expect(runAutomationRun(deps, { runId: run.id })).rejects.toThrow();
    expect(await db.select().from(schema.tasks)).toHaveLength(1);

    // 规则修复（收件人换成真人）后第三次尝试：只补通知动作，run 终判 succeeded
    await db
      .update(schema.automationRules)
      .set({
        actions: [
          { type: "create_task", config: { title: "先建任务" } },
          { type: "notify", config: { userIds: [USERS.watcher], title: "t" } },
        ],
      })
      .where(eq(schema.automationRules.id, ruleId));
    await runAutomationRun(deps, { runId: run.id });
    const finishedRows = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, run.id));
    expect(must(finishedRows[0]).status).toBe("succeeded");
    // 仍然只有一个任务：成功的动作没重跑
    expect(await db.select().from(schema.tasks)).toHaveLength(1);
    const notifications = await db.select().from(schema.notifications);
    expect(notifications).toHaveLength(1);
  });

  it("finalizes a run as failed when its rule disappears before execution", async () => {
    const ruleId = await insertRule({
      name: "会消失的规则",
      trigger: { kind: "event", action: "task.created" },
      actions: [{ type: "notify", config: { userIds: [USERS.watcher], title: "t" } }],
    });
    await insertAuditEvent({ action: "task.created", detail: {} });
    await runAutomationScan({ ...deps, sendRunJob });
    const run = await onlyRun();
    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, ruleId));
    await runAutomationRun(deps, { runId: run.id });
    const finishedRows = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, run.id));
    const finished = must(finishedRows[0]);
    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("rule no longer exists");
    expect(finished.ruleId).toBeNull();
    expect(finished.ruleName).toBe("会消失的规则");
  });

  it("sweeper resends stuck pending runs and gives up beyond the threshold", async () => {
    await insertRule({
      name: "滞留演示",
      trigger: { kind: "event", action: "task.created" },
      actions: [{ type: "notify", config: { userIds: [USERS.watcher], title: "t" } }],
    });
    await insertAuditEvent({ action: "task.created", detail: {} });
    await runAutomationScan({ ...deps, sendRunJob });
    const run = await onlyRun();
    sent.length = 0;

    // 刚插的 pending 不动
    await runAutomationScan({ ...deps, sendRunJob });
    expect(sent).toHaveLength(0);

    // 超过重发阈值：重发执行任务（补「插了行没发出任务」的缺口）
    await db
      .update(schema.automationRuns)
      .set({ createdAt: new Date(Date.now() - (RESEND_PENDING_AFTER_SECONDS + 60) * 1000) })
      .where(eq(schema.automationRuns.id, run.id));
    await runAutomationScan({ ...deps, sendRunJob });
    expect(sent).toEqual([run.id]);
    expect((await db.select().from(schema.automationRuns))[0]?.status).toBe("pending");

    // 超过 give-up 阈值：终判 failed
    await db
      .update(schema.automationRuns)
      .set({ createdAt: new Date(Date.now() - (GIVE_UP_AFTER_SECONDS + 60) * 1000) })
      .where(eq(schema.automationRuns.id, run.id));
    await runAutomationScan({ ...deps, sendRunJob });
    const finishedRows = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, run.id));
    const finished = must(finishedRows[0]);
    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("run job gave up after retries");
  });

  it("notify deduplicates recipients and does not fail the run when the bell nudge breaks", async () => {
    const ruleId = await insertRule({
      name: "去重与降级",
      trigger: { kind: "event", action: "task.created" },
      actions: [
        {
          type: "notify",
          config: { userIds: [USERS.watcher, USERS.watcher, USERS.assignee], title: "t" },
        },
      ],
    });
    await insertAuditEvent({ action: "task.created", detail: {} });
    await runAutomationScan({ ...deps, sendRunJob });
    const run = await onlyRun();
    const broken: ActionDeps = {
      ...deps,
      publishExecutor: {
        query: () => Promise.reject(new Error("bus down")),
      },
    };
    await runAutomationRun(broken, { runId: run.id });
    const finishedRows = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, run.id));
    expect(must(finishedRows[0]).status).toBe("succeeded");
    const notifications = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.aggregateId, ruleId));
    expect(notifications).toHaveLength(2);
  });

  it("a corrupted rule row finalizes as failed instead of executing garbage", async () => {
    const ruleId = await insertRule({
      name: "中途改坏的配置",
      trigger: { kind: "event", action: "task.created" },
      actions: [{ type: "notify", config: { userIds: [USERS.watcher], title: "t" } }],
    });
    await insertAuditEvent({ action: "task.created", detail: {} });
    await runAutomationScan({ ...deps, sendRunJob });
    const run = await onlyRun();
    // 规则行在执行前被改坏（手工改库/未来导入的防呆路径）：终判失败，不带病执行
    await db
      .update(schema.automationRules)
      .set({ actions: [{ type: "notify", config: { userIds: "not-an-array" } }] })
      .where(eq(schema.automationRules.id, ruleId));
    await runAutomationRun(deps, { runId: run.id });
    const finishedRows = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, run.id));
    const finished = must(finishedRows[0]);
    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("rule spec is invalid");
    const notifications = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.aggregateId, ruleId));
    expect(notifications).toHaveLength(0);
  });

  it("scan skips rules whose stored spec is invalid (logged, not fatal)", async () => {
    await db.insert(schema.automationRules).values({
      name: "库里的坏行",
      trigger: { kind: "event", action: "task.created" },
      actions: [{ type: "notify", config: { userIds: "not-an-array" } }],
      createdById: USERS.creator,
    });
    await insertAuditEvent({ action: "task.created", detail: {} });
    // 坏规则不产生 run、不拖垮扫描本身（没有抛错）
    await runAutomationScan({ ...deps, sendRunJob });
    expect(await db.select().from(schema.automationRuns)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});
