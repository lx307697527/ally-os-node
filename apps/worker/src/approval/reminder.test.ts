import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { approvalJobs } from "./index.ts";
import {
  APPROVAL_REMIND_AFTER_MS,
  APPROVAL_REMINDERS_JOB,
  runApprovalReminderScan,
  type ApprovalReminderServices,
} from "./reminder.ts";

/**
 * 催办扫描的集成测试（#221 pg-boss 催办）：真实 PostgreSQL（三表 join + 行级
 * 台账）。未设 DATABASE_URL 时跳过；独立临时库（每次运行新建、跑完 drop）。
 * 清库纪律：approval_* / notifications 无被 auth_user 之外者引用，beforeEach
 * 单独清（不动 auth_user / user_role）。
 */

const databaseUrl = process.env.DATABASE_URL;
const logger = pino({ level: "silent" });

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in test");
  return value;
}

const HOUR = 3_600_000;

function adminUrl(url: string | undefined): string {
  if (url === undefined) return "";
  const parsed = new URL(url);
  parsed.pathname = "/postgres";
  return parsed.toString();
}

describe.skipIf(!databaseUrl)("approval reminder scan (#221, integration)", () => {
  const dbName = `approval_remind_test_${String(Date.now())}_${String(process.pid)}`;
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

  // named：点名审批人；adminA/adminB：admin 角色持有者；initiator：发起人
  const named = randomUUID();
  const adminA = randomUUID();
  const adminB = randomUUID();
  const initiator = randomUUID();

  /** 记录型 pg_notify 发布器：催铃的通道与次数都可断言 */
  function fakePublisher(): {
    publishExecutor: { query(text: string, values?: unknown[]): Promise<unknown> };
    calls: { text: string; values: unknown[] | undefined }[];
  } {
    const calls: { text: string; values: unknown[] | undefined }[] = [];
    return {
      calls,
      publishExecutor: {
        query: (text: string, values?: unknown[]) => {
          calls.push({ text, values });
          return Promise.resolve(undefined);
        },
      },
    };
  }

  function services(publisher = fakePublisher(), now = (): Date => new Date()): ApprovalReminderServices {
    return { db, publishExecutor: publisher.publishExecutor, logger, instanceId: "test", now };
  }

  let configId: string;
  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
    await db.insert(schema.authUser).values([
      { id: named, name: "Named", email: "named@example.com", emailVerified: true },
      { id: adminA, name: "Admin A", email: "admin-a@example.com", emailVerified: true },
      { id: adminB, name: "Admin B", email: "admin-b@example.com", emailVerified: true },
      { id: initiator, name: "Initiator", email: "initiator@example.com", emailVerified: true },
    ]);
    await db.insert(schema.userRole).values([
      { userId: adminA, role: "admin" },
      { userId: adminB, role: "admin" },
    ]);
    const inserted = await db
      .insert(schema.approvalConfigs)
      .values({
        subjectType: "quote",
        configKey: "discount",
        name: "Discount line",
        levels: [
          { name: "lead review", users: [named], roles: [], requireSignature: false, signatureMeaning: "approved" },
          { name: "final sign-off", users: [], roles: ["admin"], requireSignature: false, signatureMeaning: "approved" },
        ],
        createdById: initiator,
      })
      .returning({ id: schema.approvalConfigs.id });
    configId = must(inserted[0]).id;
  });

  afterEach(async () => {
    // approval_actions 是 append-only（0014 触发器拒 UPDATE/DELETE），清库只能走
    // TRUNCATE（行级触发器不 fired）；requests 被 actions 引用，一条语句一起清
    // （docs/audit.md「测试清库的唯一通道」）
    await db.execute(
      sql`truncate table ${schema.approvalRequests}, ${schema.approvalActions}, ${schema.notifications} cascade`,
    );
  });

  afterAll(async () => {
    // 先关业务池再 drop：有活连接时 drop database 会失败（与 digest.test.ts 同序）
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}"`);
    await admin.pool.end();
  });

  interface RequestSpec {
    currentStep?: number;
    ageMs?: number;
    status?: "pending" | "approved" | "rejected";
    levels?: unknown;
    lastReminderAtMs?: number;
    lastReminderStep?: number | null;
  }

  async function insertRequest(spec: RequestSpec = {}): Promise<string> {
    const createdAt = new Date(Date.now() - (spec.ageMs ?? 0));
    const rows = await db
      .insert(schema.approvalRequests)
      .values({
        configId,
        configKey: "discount",
        subjectType: "quote",
        subjectId: randomUUID(),
        levels: spec.levels ?? [
          { name: "lead review", users: [named], roles: [] },
          { name: "final sign-off", users: [], roles: ["admin"] },
        ],
        currentStep: spec.currentStep ?? 0,
        status: spec.status ?? "pending",
        submittedById: initiator,
        createdAt,
        ...(spec.lastReminderAtMs !== undefined ? { lastReminderAt: new Date(spec.lastReminderAtMs) } : {}),
        ...(spec.lastReminderStep !== undefined ? { lastReminderStep: spec.lastReminderStep } : {}),
      })
      .returning({ id: schema.approvalRequests.id });
    return must(rows[0]).id;
  }

  /** 已完成级的 action 行（createdAt 即进入下一级的时刻） */
  async function insertAction(requestId: string, stepIndex: number, ageMs: number): Promise<void> {
    await db.insert(schema.approvalActions).values({
      requestId,
      stepIndex,
      levelName: stepIndex === 0 ? "lead review" : "final sign-off",
      decision: "approved",
      actorId: named,
      createdAt: new Date(Date.now() - ageMs),
    });
  }

  async function reminderRows(): Promise<{ userId: string; payload: Record<string, unknown> }[]> {
    return db
      .select({ userId: schema.notifications.userId, payload: schema.notifications.payload })
      .from(schema.notifications)
      .where(eq(schema.notifications.eventType, "approval.reminder"));
  }

  it("停满 24h 的首级请求：点名人与角色持有者各得一行提醒，台账盖到本级", async () => {
    const requestId = await insertRequest({ ageMs: 25 * HOUR });
    const publisher = fakePublisher();
    const summary = await runApprovalReminderScan(services(publisher));

    expect(summary.pendingRequests).toBe(1);
    expect(summary.dueRequests).toBe(1);
    expect(summary.skippedRequests).toBe(0);
    const rows = await reminderRows();
    expect(rows.map((r) => r.userId).sort()).toEqual([named].sort());
    expect(rows[0]?.payload).toMatchObject({
      configKey: "discount",
      configName: "Discount line",
      levelName: "lead review",
      waitingHours: 25,
      detail: "Discount line · lead review",
    });
    const stamped = await db
      .select({ at: schema.approvalRequests.lastReminderAt, step: schema.approvalRequests.lastReminderStep })
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.id, requestId));
    expect(stamped[0]?.step).toBe(0);
    expect(stamped[0]?.at).toBeInstanceOf(Date);
    // 实时「催」：每个收件人一次 pg_notify
    expect(publisher.calls).toHaveLength(1);
  });

  it("没停满 24h 的不催；催过没到再催间隔的不重复催", async () => {
    await insertRequest({ ageMs: 2 * HOUR });
    await insertRequest({ ageMs: 30 * HOUR, lastReminderAtMs: Date.now() - 2 * HOUR, lastReminderStep: 0 });
    const summary = await runApprovalReminderScan(services());
    expect(summary.dueRequests).toBe(0);
    expect(await reminderRows()).toHaveLength(0);
  });

  it("本级催过 24h 后再催一轮；级推进后按新级重新计时", async () => {
    // 本级 25h 前催过 → 到了下一轮
    await insertRequest({ ageMs: 50 * HOUR, lastReminderAtMs: Date.now() - 25 * HOUR, lastReminderStep: 0 });
    // 上一级 2h 前催过、之后推进到下一级 → 新级从未催过，立即到点（停留 30h）
    const advanced = await insertRequest({ ageMs: 30 * HOUR, currentStep: 1, lastReminderAtMs: Date.now() - 2 * HOUR, lastReminderStep: 0 });
    await insertAction(advanced, 0, 28 * HOUR);

    const summary = await runApprovalReminderScan(services());
    expect(summary.dueRequests).toBe(2);
    const rows = await reminderRows();
    // 首级收件人 = named；第二级收件人 = admin 角色持有者
    expect(rows.filter((r) => r.payload.levelName === "final sign-off").map((r) => r.userId).sort()).toEqual(
      [adminA, adminB].sort(),
    );
  });

  it("进入当前级的时刻以最后一条 action 计：请求老但刚推进的不催", async () => {
    const requestId = await insertRequest({ ageMs: 30 * HOUR, currentStep: 1 });
    await insertAction(requestId, 0, 2 * HOUR);
    const summary = await runApprovalReminderScan(services());
    expect(summary.dueRequests).toBe(0);
    expect(await reminderRows()).toHaveLength(0);
  });

  it("审批人集合为空（角色无人持有）跳过并计数；非在飞请求不理", async () => {
    await insertRequest({
      ageMs: 30 * HOUR,
      levels: [{ name: "nobody", users: [], roles: ["finance"] }],
    });
    await insertRequest({ ageMs: 30 * HOUR, status: "approved" });
    const summary = await runApprovalReminderScan(services());
    // pendingRequests 只数在飞：终态行不进扫描（催办只盯「轮到谁还没裁」）
    expect(summary.pendingRequests).toBe(1);
    expect(summary.dueRequests).toBe(0);
    expect(summary.skippedRequests).toBe(1);
    expect(await reminderRows()).toHaveLength(0);
  });

  it("levels 快照读不出（worker 侧窄 schema 不认）跳过并告警计数", async () => {
    await insertRequest({ ageMs: 30 * HOUR, levels: { not: "an array" } });
    const summary = await runApprovalReminderScan(services());
    expect(summary.pendingRequests).toBe(1);
    expect(summary.skippedRequests).toBe(1);
    expect(await reminderRows()).toHaveLength(0);
  });

  it("点名与角色并集去重：同一人既被点名又持角色只催一次", async () => {
    await insertRequest({
      ageMs: 30 * HOUR,
      levels: [{ name: "both", users: [adminA], roles: ["admin"] }],
    });
    const summary = await runApprovalReminderScan(services());
    expect(summary.remindersSent).toBe(2);
    const rows = await reminderRows();
    expect(rows.map((r) => r.userId).sort()).toEqual([adminA, adminB].sort());
  });

  it("催办节奏就是 24h 一轮（常量契约，两个语义同一值）", () => {
    expect(APPROVAL_REMIND_AFTER_MS).toBe(24 * HOUR);
  });
});

describe("approval reminder job registration (#221)", () => {
  it("approval-reminders 挂每小时 :45 的 cron", () => {
    const jobs = approvalJobs({
      db: {} as never,
      pool: { query: (): Promise<unknown> => Promise.resolve(undefined) },
      logger,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe(APPROVAL_REMINDERS_JOB);
    expect(jobs[0]?.cron).toBe("45 * * * *");
  });
});
