import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { registerDueSubject } from "./due-registry.ts";
import { runAutomationDueScan } from "./due-scanner.ts";
import type { ActionDeps } from "./actions.ts";
import { runAutomationRun } from "./runner.ts";

// 集成测试：需要真实 PostgreSQL（任务行、run 行、(rule, subject 行) 唯一约束
// 去重、make_interval 侧的 SQL 过滤）。未设 DATABASE_URL 时跳过。本文件用独立
// 临时库（每次运行新建、跑完 drop，纪律同 automations.test.ts）；pg-boss 不进
// 场——sendRunJob 注入收集桩，runner 的重试协议已在 automations.test.ts 覆盖。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

const USERS = {
  creator: randomUUID(),
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

/** 「before offset」语义下，锚点落在扫描带内（到期时刻 = now - 45s）的 due_at */
function dueAtFiringBefore(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000 - 45_000);
}

/** 「after offset」语义下，锚点落在扫描带内（到期时刻 = now - 45s）的 due_at */
function dueAtFiringAfter(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000 - 45_000);
}

describe.skipIf(!databaseUrl)("automation due scan (#224 slice 2, integration)", () => {
  const dbName = `automations_due_test_${String(Date.now())}_${String(process.pid)}`;
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

  const deps: ActionDeps = {
    db,
    publishExecutor: { query: () => Promise.resolve(undefined) },
    logger,
    instanceId: "worker-due-test",
    mailer: { send: () => Promise.resolve() },
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

  async function insertTask(values: {
    title?: string;
    status?: "open" | "done";
    dueAt?: Date | null;
    subjectType?: string | null;
  }): Promise<string> {
    const inserted = await db
      .insert(schema.tasks)
      .values({
        title: values.title ?? "到期演示任务",
        status: values.status ?? "open",
        ...(values.dueAt !== undefined ? { dueAt: values.dueAt } : {}),
        ...(values.subjectType !== undefined ? { subjectType: values.subjectType } : {}),
        createdById: USERS.creator,
      })
      .returning({ id: schema.tasks.id });
    return must(inserted[0]).id;
  }

  async function onlyRun(): Promise<{ id: string; status: string; sourceEventId: string }> {
    const rows = await db.select().from(schema.automationRuns);
    expect(rows).toHaveLength(1);
    const run = must(rows[0]);
    return { id: run.id, status: run.status, sourceEventId: run.sourceEventId };
  }

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
  });

  beforeEach(async () => {
    sent.length = 0;
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

  it("end-to-end: task due soon fires a before-offset rule and the run notifies", async () => {
    const ruleId = await insertRule({
      name: "任务到期前 1 小时提醒",
      trigger: { kind: "due", subjectType: "task", anchorField: "dueAt", direction: "before", offsetMinutes: 60 },
      actions: [{ type: "notify", config: { userIds: [USERS.watcher], title: "任务快到期" } }],
    });
    const taskId = await insertTask({ dueAt: dueAtFiringBefore(60) });

    await runAutomationDueScan({ ...deps, sendRunJob });
    const run = await onlyRun();
    expect(run.status).toBe("pending");
    expect(run.sourceEventId).toBe(taskId);
    expect(sent).toEqual([run.id]);

    await runAutomationRun(deps, { runId: run.id });
    const rows = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, run.id));
    const finished = must(rows[0]);
    expect(finished.status).toBe("succeeded");
    expect(finished.ruleId).toBe(ruleId);
    const notifications = await db.select().from(schema.notifications);
    expect(notifications).toHaveLength(1);
    expect(must(notifications[0]).userId).toBe(USERS.watcher);
    // due 触发不写审计：「到期时刻到了」不是一次业务变更
    expect(await db.select().from(schema.auditEvents)).toHaveLength(0);
  });

  it("fires once per (rule, row): rescans and the next window do not re-arm", async () => {
    await insertRule({
      name: "只响一次",
      trigger: { kind: "due", subjectType: "task", anchorField: "dueAt", direction: "before", offsetMinutes: 60 },
      actions: [{ type: "notify", config: { userIds: [USERS.watcher], title: "t" } }],
    });
    await insertTask({ dueAt: dueAtFiringBefore(60) });

    await runAutomationDueScan({ ...deps, sendRunJob });
    await runAutomationDueScan({ ...deps, sendRunJob });
    expect(await db.select().from(schema.automationRuns)).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("fires an after-offset rule when the anchor plus offset lands in the band", async () => {
    await insertRule({
      name: "到期后 1 小时跟进",
      trigger: { kind: "due", subjectType: "task", anchorField: "dueAt", direction: "after", offsetMinutes: 60 },
      actions: [{ type: "notify", config: { userIds: [USERS.watcher], title: "t" } }],
    });
    const taskId = await insertTask({ dueAt: dueAtFiringAfter(60) });

    await runAutomationDueScan({ ...deps, sendRunJob });
    const run = await onlyRun();
    expect(run.status).toBe("pending");
    expect(run.sourceEventId).toBe(taskId);
  });

  it("skips anchors outside the band: long past (no stale spam) and future", async () => {
    await insertRule({
      name: "一小时前提醒",
      trigger: { kind: "due", subjectType: "task", anchorField: "dueAt", direction: "before", offsetMinutes: 60 },
      actions: [{ type: "notify", config: { userIds: [USERS.watcher], title: "t" } }],
    });
    // 到期时刻在 10 分钟前（停摆窗外的缺口不追，与事件扫描器同一裁决）
    await insertTask({ dueAt: new Date(Date.now() + 50 * 60_000) });
    // 到期时刻在 2 小时后
    await insertTask({ dueAt: new Date(Date.now() + 120 * 60_000) });
    // 没有到期时刻

    await runAutomationDueScan({ ...deps, sendRunJob });
    expect(await db.select().from(schema.automationRuns)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("does not fire for done tasks (the member's status judgment)", async () => {
    await insertRule({
      name: "一小时前提醒",
      trigger: { kind: "due", subjectType: "task", anchorField: "dueAt", direction: "before", offsetMinutes: 60 },
      actions: [{ type: "notify", config: { userIds: [USERS.watcher], title: "t" } }],
    });
    await insertTask({ dueAt: dueAtFiringBefore(60), status: "done" });

    await runAutomationDueScan({ ...deps, sendRunJob });
    expect(await db.select().from(schema.automationRuns)).toHaveLength(0);
  });

  it("never fires on automation-created tasks (the loop guard)", async () => {
    await insertRule({
      name: "due 建任务的规则",
      trigger: { kind: "due", subjectType: "task", anchorField: "dueAt", direction: "before", offsetMinutes: 60 },
      actions: [
        { type: "create_task", config: { title: "升级任务", dueInHours: 1 } },
      ],
    });
    // 自动化自己建的子任务即便到期也不许再触发（否则每 ≥5 分钟自增一条）
    await insertTask({ dueAt: dueAtFiringBefore(60), subjectType: "automation_rule" });

    await runAutomationDueScan({ ...deps, sendRunJob });
    expect(await db.select().from(schema.automationRuns)).toHaveLength(0);
  });

  it("fail-closed on unregistered subject types and undeclared anchor fields", async () => {
    await insertRule({
      name: "subject 没注册",
      trigger: { kind: "due", subjectType: "appointment", anchorField: "startsAt", direction: "before", offsetMinutes: 60 },
      actions: [{ type: "notify", config: { userIds: [USERS.watcher], title: "t" } }],
    });
    await insertRule({
      name: "字段没声明",
      trigger: { kind: "due", subjectType: "task", anchorField: "createdAt", direction: "before", offsetMinutes: 60 },
      actions: [{ type: "notify", config: { userIds: [USERS.watcher], title: "t" } }],
    });
    await insertRule({
      name: "库里坏行不拖垮扫描",
      trigger: { kind: "due", subjectType: "task", anchorField: "dueAt", direction: "before", offsetMinutes: 60 },
      actions: [{ type: "notify", config: { userIds: "not-an-array" } }],
    });
    await insertTask({ dueAt: dueAtFiringBefore(60) });

    // 没抛错（扫描活着），坏配置一条 run 都不产生；在带内的合法 task 行没有
    // 命中规则（三条规则全被跳过）
    await runAutomationDueScan({ ...deps, sendRunJob });
    expect(await db.select().from(schema.automationRuns)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("event triggers belong to the event scanner, not the due scan", async () => {
    await insertRule({
      name: "事件规则",
      trigger: { kind: "event", action: "task.created" },
      actions: [{ type: "notify", config: { userIds: [USERS.watcher], title: "t" } }],
    });
    await insertTask({ dueAt: dueAtFiringBefore(60) });

    await runAutomationDueScan({ ...deps, sendRunJob });
    expect(await db.select().from(schema.automationRuns)).toHaveLength(0);
  });

  it("conditions failing on the projected row produce a skipped run", async () => {
    await insertRule({
      name: "只提醒特定标题",
      trigger: { kind: "due", subjectType: "task", anchorField: "dueAt", direction: "before", offsetMinutes: 60 },
      conditions: [{ path: "detail.title", op: "eq", value: "别的任务" }],
      actions: [{ type: "notify", config: { userIds: [USERS.watcher], title: "t" } }],
    });
    await insertTask({ title: "到期演示任务", dueAt: dueAtFiringBefore(60) });

    await runAutomationDueScan({ ...deps, sendRunJob });
    const run = await onlyRun();
    expect(run.status).toBe("skipped");
    expect(sent).toHaveLength(0);
  });

  it("registered fixture subjects ride the same seam (future domains register, kernel unchanged)", async () => {
    const fixtureRowId = randomUUID();
    registerDueSubject("meeting", {
      anchorFields: ["startsAt"],
      loadDueRows() {
        return Promise.resolve([{ id: fixtureRowId, detail: { title: "客户会议" } }]);
      },
    });
    await insertRule({
      name: "会前 2 小时提醒",
      trigger: { kind: "due", subjectType: "meeting", anchorField: "startsAt", direction: "before", offsetMinutes: 120 },
      actions: [{ type: "notify", config: { userIds: [USERS.watcher], title: "快开会了" } }],
    });

    await runAutomationDueScan({ ...deps, sendRunJob });
    const run = await onlyRun();
    expect(run.status).toBe("pending");
    expect(run.sourceEventId).toBe(fixtureRowId);
  });
});
