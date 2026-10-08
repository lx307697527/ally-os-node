import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { billingJobs } from "./index.ts";
import {
  INVOICE_OVERDUE_REMINDERS_JOB,
  OVERDUE_REMIND_AFTER_MS,
  runInvoiceOverdueScan,
  type OverdueScanServices,
} from "./overdue.ts";

/**
 * 逾期扫描的集成测试（#192 due 扫描半边，R-12-7）：真实 PostgreSQL（候选过滤
 * + 行级台账 + 生成列 SUM）。未设 DATABASE_URL 时跳过；独立临时库（每次运行
 * 新建、跑完 drop）。清库纪律：invoices（行随 cascade）/ payments / notifications
 * 在 beforeEach 清（不动 auth_user / user_role / user_permission）。
 */

const databaseUrl = process.env.DATABASE_URL;
const logger = pino({ level: "silent" });

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in test");
  return value;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function adminUrl(url: string | undefined): string {
  if (url === undefined) return "";
  const parsed = new URL(url);
  parsed.pathname = "/postgres";
  return parsed.toString();
}

describe.skipIf(!databaseUrl)("invoice overdue scan (#192, integration)", () => {
  const dbName = `invoice_overdue_test_${String(Date.now())}_${String(process.pid)}`;
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

  // fin/own：角色默认收件人；grantee：个人授权；bystander：不该收到的人
  const fin = randomUUID();
  const own = randomUUID();
  const grantee = randomUUID();
  const bystander = randomUUID();

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

  function services(publisher = fakePublisher(), now = (): Date => new Date()): OverdueScanServices {
    return { db, publishExecutor: publisher.publishExecutor, logger, instanceId: "test", now };
  }

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
    await db.insert(schema.authUser).values([
      { id: fin, name: "Fin", email: "fin@example.com", emailVerified: true },
      { id: own, name: "Own", email: "own@example.com", emailVerified: true },
      { id: grantee, name: "Grantee", email: "grantee@example.com", emailVerified: true },
      { id: bystander, name: "Bystander", email: "bystander@example.com", emailVerified: true },
    ]);
    await db.insert(schema.userRole).values([
      { userId: fin, role: "finance" },
      { userId: own, role: "owner" },
    ]);
    await db
      .insert(schema.userPermission)
      .values({ userId: grantee, permission: "invoices.manage" });
  });

  afterEach(async () => {
    await db.execute(
      sql`truncate table ${schema.payments}, ${schema.invoiceLines}, ${schema.invoices}, ${schema.notifications} cascade`,
    );
  });

  afterAll(async () => {
    // 先关业务池再 drop：有活连接时 drop database 会失败（reminder.test.ts 同序）
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}"`);
    await admin.pool.end();
  });

  let numberSeq = 1000;

  interface InvoiceSpec {
    status?: "draft" | "issued" | "void";
    /** dueAt 相对 now 的偏移（负数 = 已过期）；缺省 null = 未约定账期 */
    dueInMs?: number | undefined;
    reminderAgeMs?: number;
    lines?: { quantity: number; unitPriceCents: number }[];
    payments?: { amountCents: number; voided?: boolean }[];
  }

  /** 直落票例行（不经 createDraftInvoice——扫描读的是表不是服务） */
  async function insertInvoice(spec: InvoiceSpec = {}): Promise<string> {
    numberSeq += 1;
    const now = Date.now();
    const rows = await db
      .insert(schema.invoices)
      .values({
        number: `INV-${String(numberSeq)}`,
        invoiceType: "balance",
        status: spec.status ?? "issued",
        dueAt: spec.dueInMs === undefined ? null : new Date(now + spec.dueInMs),
        overdueReminderAt:
          spec.reminderAgeMs !== undefined ? new Date(now - spec.reminderAgeMs) : null,
        ...(spec.status === "issued" ? { issuedAt: new Date(now) } : {}),
      })
      .returning({ id: schema.invoices.id });
    const id = must(rows[0]).id;
    const lines = spec.lines ?? [{ quantity: 2, unitPriceCents: 10_000 }];
    await db.insert(schema.invoiceLines).values(
      lines.map((line, index) => ({
        invoiceId: id,
        lineNumber: index + 1,
        description: "batch balance",
        quantity: line.quantity.toFixed(3),
        unitPriceCents: line.unitPriceCents,
      })),
    );
    for (const payment of spec.payments ?? []) {
      await db.insert(schema.payments).values({
        invoiceId: id,
        method: "wire_ach",
        amountCents: payment.amountCents,
        receivedAt: new Date(now),
        ...(payment.voided
          ? { voidedAt: new Date(now), voidReason: "booked twice" }
          : {}),
      });
    }
    return id;
  }

  async function overdueRows(): Promise<
    { userId: string; aggregateId: string | null; payload: Record<string, unknown> }[]
  > {
    return db
      .select({
        userId: schema.notifications.userId,
        aggregateId: schema.notifications.aggregateId,
        payload: schema.notifications.payload,
      })
      .from(schema.notifications)
      .where(eq(schema.notifications.eventType, "invoice.overdue"));
  }

  it("逾期未付：invoices.manage 持有者各得一行，台账盖章、金额事实成句、逐人实时催", async () => {
    const id = await insertInvoice({ dueInMs: -3 * DAY, lines: [{ quantity: 2, unitPriceCents: 10_000 }] });
    const publisher = fakePublisher();
    const summary = await runInvoiceOverdueScan(services(publisher));

    expect(summary.overdueInvoices).toBe(1);
    expect(summary.remindersSent).toBe(3);
    expect(summary.skippedInvoices).toBe(0);
    const rows = await overdueRows();
    expect(rows.map((r) => r.userId).sort()).toEqual([fin, own, grantee].sort());
    expect(rows[0]?.aggregateId).toBe(id);
    expect(rows[0]?.payload).toMatchObject({
      invoiceNumber: `INV-${String(numberSeq)}`,
      outstandingCents: 20_000,
      currency: "USD",
      daysOverdue: 3,
      title: `Invoice INV-${String(numberSeq)} is overdue`,
      detail: "USD 200.00 outstanding — was due " + new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10),
    });
    const stamped = await db
      .select({ at: schema.invoices.overdueReminderAt })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, id));
    expect(stamped[0]?.at).toBeInstanceOf(Date);
    // 实时「催」：每个收件人一次 pg_notify
    expect(publisher.calls).toHaveLength(3);
  });

  it("付清（paid >= total）不催；部分收款按欠款成句", async () => {
    await insertInvoice({ dueInMs: -3 * DAY, payments: [{ amountCents: 20_000 }] });
    const partial = await insertInvoice({
      dueInMs: -3 * DAY,
      payments: [{ amountCents: 5_000 }],
    });
    const summary = await runInvoiceOverdueScan(services());

    expect(summary.overdueInvoices).toBe(1);
    const rows = await overdueRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]?.payload).toMatchObject({ outstandingCents: 15_000 });
    expect(rows.every((r) => r.aggregateId === partial)).toBe(true);
  });

  it("作废的钱行不抵扣：SUM 剔除 void 行", async () => {
    await insertInvoice({ dueInMs: -3 * DAY, payments: [{ amountCents: 20_000, voided: true }] });
    const summary = await runInvoiceOverdueScan(services());
    expect(summary.overdueInvoices).toBe(1);
    const rows = await overdueRows();
    expect(rows[0]?.payload).toMatchObject({ outstandingCents: 20_000 });
  });

  it("未到期 / 未约定账期（dueAt null）/ 草稿票不进候选集", async () => {
    await insertInvoice({ dueInMs: 3 * DAY });
    await insertInvoice({ dueInMs: undefined });
    await insertInvoice({ dueInMs: -3 * DAY, status: "draft" });
    const summary = await runInvoiceOverdueScan(services());
    expect(summary.overdueInvoices).toBe(0);
    expect(await overdueRows()).toHaveLength(0);
  });

  it("$0 票 vacuously paid：没有欠款就没有逾期语义", async () => {
    await insertInvoice({ dueInMs: -3 * DAY, lines: [{ quantity: 0.5, unitPriceCents: 0 }] });
    const summary = await runInvoiceOverdueScan(services());
    expect(summary.overdueInvoices).toBe(0);
  });

  it("催过没到再催间隔的不重复催；催过满 24h 的再催一轮", async () => {
    await insertInvoice({ dueInMs: -3 * DAY, reminderAgeMs: 2 * HOUR });
    const again = await insertInvoice({ dueInMs: -3 * DAY, reminderAgeMs: 25 * HOUR });
    const summary = await runInvoiceOverdueScan(services());
    expect(summary.overdueInvoices).toBe(1);
    const rows = await overdueRows();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.aggregateId === again)).toBe(true);
  });

  it("重复投递被 dedupe_key 吃掉（同一天内至多一行/人）", async () => {
    const id = await insertInvoice({ dueInMs: -3 * DAY });
    await runInvoiceOverdueScan(services());
    // 手抹台账模拟同轮重投（绕开 24h 门槛的等价路径）
    await db
      .update(schema.invoices)
      .set({ overdueReminderAt: null })
      .where(eq(schema.invoices.id, id));
    const second = await runInvoiceOverdueScan(services());
    expect(second.overdueInvoices).toBe(1);
    const rows = await overdueRows();
    expect(rows).toHaveLength(3);
  });

  it("无收件人（财务矩阵为空）整轮跳过并计数；bystander 不在名单里", async () => {
    await insertInvoice({ dueInMs: -3 * DAY });
    // 临时清空收件人矩阵（角色 + 个人授权），finally 恢复——空名单是部署态，
    // 提醒没人看得见是假成功：整轮跳过 + skippedInvoices 计数
    await db.delete(schema.userRole).where(sql`true`);
    await db.delete(schema.userPermission).where(sql`true`);
    try {
      const summary = await runInvoiceOverdueScan(services());
      expect(summary.overdueInvoices).toBe(0);
      expect(summary.skippedInvoices).toBe(1);
      expect(await overdueRows()).toHaveLength(0);
    } finally {
      await db.insert(schema.userRole).values([
        { userId: fin, role: "finance" },
        { userId: own, role: "owner" },
      ]);
      await db
        .insert(schema.userPermission)
        .values({ userId: grantee, permission: "invoices.manage" });
    }

    // 对照半边：矩阵恢复后同一张票正常催，且无角色无授权的 bystander 不在名单
    const summary = await runInvoiceOverdueScan(services());
    expect(summary.overdueInvoices).toBe(1);
    const rows = await overdueRows();
    expect(rows.map((r) => r.userId).sort()).toEqual([fin, own, grantee].sort());
    expect(rows.map((r) => r.userId)).not.toContain(bystander);
  });

  it("催办节奏就是 24h 一轮（常量契约）", () => {
    expect(OVERDUE_REMIND_AFTER_MS).toBe(24 * HOUR);
  });
});

describe("invoice overdue reminder job registration (#192)", () => {
  it("invoice-overdue-reminders 挂每日 13:10 UTC 的 cron（排在摘要 13:30 之前）", () => {
    const jobs = billingJobs({
      db: {} as never,
      pool: { query: (): Promise<unknown> => Promise.resolve(undefined) },
      logger,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe(INVOICE_OVERDUE_REMINDERS_JOB);
    expect(jobs[0]?.cron).toBe("10 13 * * *");
  });
});
