import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { workflowJobs } from "./index.ts";
import {
  WORKFLOW_REMIND_AFTER_MS,
  WORKFLOW_TIMEOUT_REMINDERS_JOB,
  runWorkflowTimeoutScan,
  type WorkflowReminderServices,
} from "./reminder.ts";

/**
 * 超时提醒扫描的集成测试（#220「超时后负责人收到提醒」的投递半边）：真实
 * PostgreSQL（超时过滤 + 行级台账）。未设 DATABASE_URL 时跳过；独立临时库
 * （每次运行新建、跑完 drop）。清库纪律：workflow_instances（无 append-only
 * 触发器，历史表在 workflow_transitions，本套件不写它）/ notifications 在
 * beforeEach 单独清（不动 auth_user / user_role）。
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

describe.skipIf(!databaseUrl)("workflow timeout reminder scan (#220, integration)", () => {
  const dbName = `workflow_remind_test_${String(Date.now())}_${String(process.pid)}`;
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

  // starter：发起人；leadA/leadB：sales_lead 持有者；bystander：无角色员工
  const starter = randomUUID();
  const leadA = randomUUID();
  const leadB = randomUUID();
  const bystander = randomUUID();

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

  function services(publisher = fakePublisher(), now = (): Date => new Date()): WorkflowReminderServices {
    return { db, publishExecutor: publisher.publishExecutor, logger, instanceId: "test", now };
  }

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
    await db.insert(schema.authUser).values([
      { id: starter, name: "Starter", email: "starter@example.com", emailVerified: true },
      { id: leadA, name: "Lead A", email: "lead-a@example.com", emailVerified: true },
      { id: leadB, name: "Lead B", email: "lead-b@example.com", emailVerified: true },
      { id: bystander, name: "Bystander", email: "bystander@example.com", emailVerified: true },
    ]);
    await db.insert(schema.userRole).values([
      { userId: leadA, role: "sales_lead" },
      { userId: leadB, role: "sales_lead" },
    ]);
  });

  afterEach(async () => {
    await db.execute(sql`truncate table ${schema.workflowInstances}, ${schema.notifications} cascade`);
  });

  afterAll(async () => {
    // 先关业务池再 drop：有活连接时 drop database 会失败（与 digest.test.ts 同序）
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}"`);
    await admin.pool.end();
  });

  interface InstanceSpec {
    enteredAgeMs?: number;
    /** 状态超时（小时）；缺省 48 → 缺省 enteredAgeMs 下还没到期 */
    timeoutHours?: number;
    startedBy?: string | null;
    reminderAgeMs?: number;
    definition?: unknown;
    currentState?: string;
  }

  /** 审批催办同一形态的插入器：直接落实例行（worker 扫描不经过 subject 注册表） */
  async function insertInstance(spec: InstanceSpec = {}): Promise<string> {
    const enteredAgeMs = spec.enteredAgeMs ?? 2 * HOUR;
    const timeoutHours = spec.timeoutHours ?? 48;
    const enteredAt = new Date(Date.now() - enteredAgeMs);
    const rows = await db
      .insert(schema.workflowInstances)
      .values({
        subjectType: "flow_lead",
        subjectId: randomUUID(),
        templateKey: "standard_lead",
        definition: spec.definition ?? {
          initial: "review",
          states: {
            review: {
              timeoutAfterHours: timeoutHours,
              on: { APPROVE: { target: "done", roles: ["sales_lead"] } },
            },
            done: {},
          },
        },
        currentState: spec.currentState ?? "review",
        stateEnteredAt: enteredAt,
        stateDueAt: new Date(enteredAt.getTime() + timeoutHours * HOUR),
        stateReminderAt:
          spec.reminderAgeMs !== undefined ? new Date(Date.now() - spec.reminderAgeMs) : null,
        startedById: spec.startedBy === undefined ? starter : spec.startedBy,
      })
      .returning({ id: schema.workflowInstances.id });
    return must(rows[0]).id;
  }

  async function reminderRows(): Promise<{ userId: string; payload: Record<string, unknown> }[]> {
    return db
      .select({ userId: schema.notifications.userId, payload: schema.notifications.payload })
      .from(schema.notifications)
      .where(eq(schema.notifications.eventType, "workflow.state_overdue"));
  }

  it("超时首催：发起人 ∪ 能推当前状态的角色持有者各得一行，台账盖章、逐人实时催", async () => {
    const instanceId = await insertInstance({ enteredAgeMs: 50 * HOUR, timeoutHours: 48 });
    const publisher = fakePublisher();
    const summary = await runWorkflowTimeoutScan(services(publisher));

    expect(summary.dueInstances).toBe(1);
    expect(summary.remindersSent).toBe(3);
    expect(summary.skippedInstances).toBe(0);
    const rows = await reminderRows();
    expect(rows.map((r) => r.userId).sort()).toEqual([starter, leadA, leadB].sort());
    expect(rows[0]?.payload).toMatchObject({
      subjectType: "flow_lead",
      templateKey: "standard_lead",
      stateName: "review",
      waitingHours: 50,
      title: 'standard_lead has been in "review"',
      detail: "standard_lead · review",
    });
    expect(typeof rows[0]?.payload.dueAt).toBe("string");
    const stamped = await db
      .select({ at: schema.workflowInstances.stateReminderAt })
      .from(schema.workflowInstances)
      .where(eq(schema.workflowInstances.id, instanceId));
    expect(stamped[0]?.at).toBeInstanceOf(Date);
    // 实时「催」：每个收件人一次 pg_notify
    expect(publisher.calls).toHaveLength(3);
  });

  it("没到 stateDueAt 的不催", async () => {
    await insertInstance({ enteredAgeMs: 2 * HOUR, timeoutHours: 48 });
    const summary = await runWorkflowTimeoutScan(services());
    expect(summary.dueInstances).toBe(0);
    expect(await reminderRows()).toHaveLength(0);
  });

  it("催过没到再催间隔的不重复催；催过满 24h 的再催一轮", async () => {
    await insertInstance({ enteredAgeMs: 50 * HOUR, reminderAgeMs: 2 * HOUR });
    const again = await insertInstance({ enteredAgeMs: 74 * HOUR, reminderAgeMs: 25 * HOUR });
    const summary = await runWorkflowTimeoutScan(services());
    expect(summary.dueInstances).toBe(1);
    const rows = await reminderRows();
    expect(rows.map((r) => r.userId).sort()).toEqual([starter, leadA, leadB].sort());
    const stamped = await db
      .select({ at: schema.workflowInstances.stateReminderAt })
      .from(schema.workflowInstances)
      .where(eq(schema.workflowInstances.id, again));
    expect(stamped[0]?.at).toBeInstanceOf(Date);
  });

  it("definition 快照读不出（worker 侧窄 schema 不认）跳过并告警计数", async () => {
    await insertInstance({ enteredAgeMs: 50 * HOUR, definition: { not: "a template" } });
    const summary = await runWorkflowTimeoutScan(services());
    expect(summary.dueInstances).toBe(0);
    expect(summary.skippedInstances).toBe(1);
    expect(await reminderRows()).toHaveLength(0);
  });

  it("收件人集合为空（发起人 null + 出边角色无人持有）跳过并告警计数", async () => {
    await insertInstance({
      enteredAgeMs: 50 * HOUR,
      startedBy: null,
      definition: {
        initial: "review",
        states: { review: { on: { APPROVE: { target: "done", roles: ["finance"] } } }, done: {} },
      },
    });
    const summary = await runWorkflowTimeoutScan(services());
    expect(summary.dueInstances).toBe(0);
    expect(summary.skippedInstances).toBe(1);
    expect(await reminderRows()).toHaveLength(0);
  });

  it("发起人自己持角色只催一次；无角色的出边（字符串简写）不贡献收件人", async () => {
    await db.insert(schema.userRole).values({ userId: starter, role: "sales_lead" });
    try {
      await insertInstance({
        enteredAgeMs: 50 * HOUR,
        definition: {
          initial: "review",
          states: {
            review: {
              on: { APPROVE: { target: "done", roles: ["sales_lead"] }, ESCALATE: "escalated" },
            },
            done: {},
            escalated: {},
          },
        },
      });
      const summary = await runWorkflowTimeoutScan(services());
      expect(summary.dueInstances).toBe(1);
      expect(summary.remindersSent).toBe(3);
      const rows = await reminderRows();
      // 发起人（sales_lead 持有者）与 leadA/leadB 的并集去重 = 3 人，无第四行
      expect(rows.map((r) => r.userId).sort()).toEqual([starter, leadA, leadB].sort());
    } finally {
      await db.delete(schema.userRole).where(eq(schema.userRole.userId, starter));
    }
  });

  it("多角色出边取并集：各角色持有者都进收件人", async () => {
    await insertInstance({
      enteredAgeMs: 50 * HOUR,
      startedBy: null,
      definition: {
        initial: "review",
        states: {
          review: {
            on: {
              APPROVE: { target: "done", roles: ["sales_lead"] },
              REJECT: { target: "done", roles: ["admin"] },
            },
          },
          done: {},
        },
      },
    });
    const admin = randomUUID();
    await db.insert(schema.authUser).values({
      id: admin,
      name: "Admin",
      email: "admin-remind@example.com",
      emailVerified: true,
    });
    await db.insert(schema.userRole).values({ userId: admin, role: "admin" });
    try {
      const summary = await runWorkflowTimeoutScan(services());
      expect(summary.dueInstances).toBe(1);
      const rows = await reminderRows();
      expect(rows.map((r) => r.userId).sort()).toEqual([leadA, leadB, admin].sort());
    } finally {
      await db.delete(schema.authUser).where(eq(schema.authUser.id, admin));
    }
  });

  it("催办节奏就是 24h 一轮（常量契约）", () => {
    expect(WORKFLOW_REMIND_AFTER_MS).toBe(24 * HOUR);
  });
});

describe("workflow timeout reminder job registration (#220)", () => {
  it("workflow-timeout-reminders 挂每小时 :50 的 cron", () => {
    const jobs = workflowJobs({
      db: {} as never,
      pool: { query: (): Promise<unknown> => Promise.resolve(undefined) },
      logger,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe(WORKFLOW_TIMEOUT_REMINDERS_JOB);
    expect(jobs[0]?.cron).toBe("50 * * * *");
  });
});
