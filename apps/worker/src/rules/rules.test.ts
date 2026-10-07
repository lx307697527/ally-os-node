import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema, type Db } from "@ally/db";
import { rulesJobs } from "./index.ts";
import {
  RULES_REMINDER_ACTOR,
  RULE_REMINDER_SUBJECT_TYPE,
  runRulesPendingReminderScan,
  type ReminderServices,
} from "./reminder.ts";

// 集成测试：需要真实 PostgreSQL（0021 种子即断言面、任务/通知/审计行、事务）。
// 未设 DATABASE_URL 时跳过。独立临时库（每次运行新建、跑完 drop）。
//
// 清库纪律：auth_user 与 registry_rules **不在 beforeEach 里清**——TRUNCATE
// auth_user 会沿 FK CASCADE 连带清掉 registry_rules（scheduled_by_id 引用），
// 0021 的 57 条种子就没了；tasks/notifications/audit_events 没有被任何表引用，
// 单独清安全。隔离靠「每条测试动自己的规则」+ 按 subject/assignee 限定断言。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

const USERS = {
  owner1: randomUUID(),
  admin1: randomUUID(),
  admin2: randomUUID(),
  lead1: randomUUID(),
} as const;

const USER_ROLES = {
  owner1: "owner",
  admin1: "admin",
  admin2: "admin",
  lead1: "sales_lead",
} as const;

/** 0021 种子里 8 条 value IS NULL 的规则，按「谁能改」分组 */
const SEED_PENDING = {
  ownerOnly: [
    "pricing.label_design_fee_usd",
    "procurement.po_approval_threshold_usd",
    "refunds.owner_approval_threshold_usd",
    "compliance.regulatory_risk_list",
    "compensation.commission_rules",
  ],
  admin: ["pricing.customer_supplied_material_fees", "storage.finished_goods_monthly_rate_usd"],
  salesLead: ["pricing.non_quantity_discount_cap_pct"],
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

describe.skipIf(!databaseUrl)("rules pending reminder scan (#233 slice 2, integration)", () => {
  const dbName = `rules_worker_test_${String(Date.now())}_${String(process.pid)}`;
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

  const notifyCalls: { text: string; values?: unknown[] | undefined }[] = [];
  const services: ReminderServices = {
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

  async function ruleIdByKey(key: string): Promise<string> {
    const rows = await db
      .select({ id: schema.registryRules.id })
      .from(schema.registryRules)
      .where(eq(schema.registryRules.key, key))
      .limit(1);
    return must(rows[0]).id;
  }

  function reminderTasks(): Promise<
    { id: string; assigneeId: string | null; status: string; subjectId: string | null; deletedAt: Date | null }[]
  > {
    return db
      .select({
        id: schema.tasks.id,
        assigneeId: schema.tasks.assigneeId,
        status: schema.tasks.status,
        subjectId: schema.tasks.subjectId,
        deletedAt: schema.tasks.deletedAt,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.subjectType, RULE_REMINDER_SUBJECT_TYPE));
  }

  async function openAssignees(ruleKey: string): Promise<string[]> {
    const id = await ruleIdByKey(ruleKey);
    const rows = await reminderTasks();
    return rows
      .filter((row) => row.subjectId === id && row.status === "open")
      .map((row) => must(row.assigneeId))
      .sort();
  }

  async function insertFixtureRule(values: {
    key: string;
    changeableBy: string[];
  }): Promise<string> {
    const inserted = await db
      .insert(schema.registryRules)
      .values({
        key: values.key,
        label: `Fixture rule ${values.key}`,
        category: "param",
        valueType: "number",
        value: null,
        changeableBy: values.changeableBy,
        adjudicationRefs: ["R-99-1"],
      })
      .returning({ id: schema.registryRules.id });
    return must(inserted[0]).id;
  }

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
    await db.insert(schema.authUser).values(
      Object.entries(USERS).map(([name, id]) => ({
        id,
        name: name.charAt(0).toUpperCase() + name.slice(1),
        email: `${name}@example.com`,
        emailVerified: true,
      })),
    );
    await db.insert(schema.userRole).values(
      Object.entries(USER_ROLES).map(([name, role]) => ({
        userId: USERS[name as keyof typeof USERS],
        role,
      })),
    );
  });

  beforeEach(async () => {
    notifyCalls.length = 0;
    // 单语句 TRUNCATE：只清提醒产物，人与规则（种子 + 前序测试的改动）保留
    await db.execute(
      sql`truncate table ${schema.tasks}, ${schema.notifications}, ${schema.auditEvents}`,
    );
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}"`);
    await admin.pool.end();
  });

  it("creates one open reminder per changeableBy holder for each seeded pending rule", async () => {
    const summary = await runRulesPendingReminderScan(services);
    expect(summary).toEqual({ pendingRules: 8, tasksCreated: 10, tasksClosed: 0, skippedRules: 0 });

    for (const key of SEED_PENDING.ownerOnly) {
      expect(await openAssignees(key)).toEqual([USERS.owner1]);
    }
    for (const key of SEED_PENDING.admin) {
      // openAssignees 按 uuid 字典序返回；期望也排序——uuid 是随机的，声明序
      // 断言等于每跑一次掷一次硬币（CI 上真炸过一次）
      expect(await openAssignees(key)).toEqual([USERS.admin1, USERS.admin2].sort());
    }
    expect(await openAssignees(SEED_PENDING.salesLead[0])).toEqual([USERS.lead1]);

    // 任务形状：附着在规则行上，系统创建，英文文案
    const labelId = await ruleIdByKey("pricing.label_design_fee_usd");
    const rows = await db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.subjectId, labelId), eq(schema.tasks.status, "open")));
    const task = must(rows[0]);
    expect(task.title).toBe("Fill in registry rule: Label design service fee (USD, per order overridable)");
    expect(task.description).toContain("pricing.label_design_fee_usd");
    expect(task.description).toContain("OWNER-DECISION-2026-09-30");
    expect(task.createdById).toBeNull();
    expect(task.subjectType).toBe(RULE_REMINDER_SUBJECT_TYPE);
    expect(task.assigneeId).toBe(USERS.owner1);

    // 同事务的 task.created 审计与 task.assigned 站内通知
    const audits = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.auditEvents)
      .where(
        and(eq(schema.auditEvents.actor, RULES_REMINDER_ACTOR), eq(schema.auditEvents.action, "task.created")),
      );
    expect(audits[0]?.n).toBe(10);
    const notifications = await db
      .select({ payload: schema.notifications.payload })
      .from(schema.notifications)
      .where(eq(schema.notifications.eventType, "task.assigned"));
    expect(notifications).toHaveLength(10);
    expect(notifications[0]?.payload).toMatchObject({ actorName: "Rules registry" });

    // 实时「催」在提交后发，按人去重（4 个收件人）
    expect(notifyCalls).toHaveLength(4);
    expect(notifyCalls[0]?.text).toBe("select pg_notify($1, $2)");
  });

  it("is idempotent: a second pass creates nothing new", async () => {
    await runRulesPendingReminderScan(services);
    notifyCalls.length = 0;
    const second = await runRulesPendingReminderScan(services);
    expect(second).toEqual({ pendingRules: 8, tasksCreated: 0, tasksClosed: 0, skippedRules: 0 });
    expect(await reminderTasks()).toHaveLength(10);
    const notifications = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.notifications);
    expect(notifications[0]?.n).toBe(10);
    expect(notifyCalls).toHaveLength(0);
  });

  it("closes stale reminders once the rule value is filled", async () => {
    await runRulesPendingReminderScan(services);
    await db
      .update(schema.registryRules)
      .set({ value: 25, updatedAt: new Date() })
      .where(eq(schema.registryRules.key, "pricing.label_design_fee_usd"));

    const summary = await runRulesPendingReminderScan(services);
    expect(summary).toEqual({ pendingRules: 7, tasksCreated: 0, tasksClosed: 1, skippedRules: 0 });
    expect(await openAssignees("pricing.label_design_fee_usd")).toEqual([]);

    const labelId = await ruleIdByKey("pricing.label_design_fee_usd");
    const closed = await db
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.subjectId, labelId));
    expect(closed.map((row) => row.status).sort()).toEqual(["done"]);
    const statusAudits = await db
      .select({ detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "task.status_changed"));
    expect(statusAudits).toHaveLength(1);
    expect(statusAudits[0]?.detail).toMatchObject({
      via: "rules-reminder",
      ruleKey: "pricing.label_design_fee_usd",
      from: "open",
      to: "done",
    });

    // 其余 7 条待填规则（4 owner + 2 admin×2 + 1 lead）的提醒不受影响
    const open = await reminderTasks();
    expect(open.filter((row) => row.status === "open")).toHaveLength(9);
  });

  it("recreates a reminder dismissed by its assignee while the value is still pending", async () => {
    await runRulesPendingReminderScan(services);
    const discountId = await ruleIdByKey("pricing.non_quantity_discount_cap_pct");
    await db
      .update(schema.tasks)
      .set({ status: "done", updatedAt: new Date() })
      .where(and(eq(schema.tasks.subjectId, discountId), eq(schema.tasks.status, "open")));

    const summary = await runRulesPendingReminderScan(services);
    expect(summary.tasksCreated).toBe(1);
    const rows = await reminderTasks();
    const mine = rows.filter((row) => row.subjectId === discountId);
    expect(mine.filter((row) => row.status === "open")).toHaveLength(1);
    expect(mine.filter((row) => row.status === "done")).toHaveLength(1);
  });

  it("rebuilds a soft-deleted reminder while the value is still pending (#29 slice 2)", async () => {
    await runRulesPendingReminderScan(services);
    const discountId = await ruleIdByKey("pricing.non_quantity_discount_cap_pct");
    // 删除 = 软删（deleted_at 置列）：对账扫描当它不存在，规则仍待填就重建——
    // 与「提前 done 而值仍空」同一纪律，待办的目的就是填值
    await db
      .update(schema.tasks)
      .set({ deletedAt: new Date() })
      .where(and(eq(schema.tasks.subjectId, discountId), eq(schema.tasks.status, "open")));

    const summary = await runRulesPendingReminderScan(services);
    expect(summary.tasksCreated).toBe(1);
    const rows = await reminderTasks();
    const mine = rows.filter((row) => row.subjectId === discountId);
    // 软删行对扫描不可见（status 仍是 open 但 deleted_at 非空）：活着的那条 open
    // 才算数，删除的那条留在原地作历史
    expect(mine.filter((row) => row.status === "open" && row.deletedAt === null)).toHaveLength(1);
    expect(mine.filter((row) => row.deletedAt !== null)).toHaveLength(1);
  });

  it("falls back to owner when no user holds the changeableBy roles", async () => {
    await insertFixtureRule({ key: "test.fallback_rule", changeableBy: ["qa", "wizard"] });
    const summary = await runRulesPendingReminderScan(services);
    expect(summary.skippedRules).toBe(0);
    // qa/wizard 无人持有 → 回落 owner（owner 恒可改）
    expect(await openAssignees("test.fallback_rule")).toEqual([USERS.owner1]);
  });

  it("skips a rule when neither changeableBy holders nor owner exist", async () => {
    const orphanId = await insertFixtureRule({ key: "test.orphan_rule", changeableBy: ["finance"] });
    // 暂时摘掉唯一的 owner 角色持有者
    await db.delete(schema.userRole).where(eq(schema.userRole.userId, USERS.owner1));
    try {
      const summary = await runRulesPendingReminderScan(services);
      expect(summary.skippedRules).toBeGreaterThanOrEqual(1);
      const rows = await reminderTasks();
      expect(rows.filter((row) => row.subjectId === orphanId)).toEqual([]);
    } finally {
      await db
        .insert(schema.userRole)
        .values({ userId: USERS.owner1, role: "owner" });
    }
  });
});

describe("rulesJobs registration", () => {
  it("registers the daily pending-reminder job", () => {
    const stubDb = {} as unknown as Db;
    const jobs = rulesJobs({
      db: stubDb,
      pool: { query: () => Promise.resolve(undefined) },
      mailer: { send: () => Promise.resolve() },
      webAppUrl: undefined,
      logger,
    });
    expect(jobs.map((job) => job.name)).toContain("rules-pending-reminder");
    const reminder = jobs.find((job) => job.name === "rules-pending-reminder");
    expect(reminder?.cron).toBe("0 13 * * *");
  });
});
