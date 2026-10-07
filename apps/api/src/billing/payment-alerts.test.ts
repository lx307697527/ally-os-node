import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import {
  PAYMENT_ATTEMPT_FAILED_EVENT,
  PAYMENT_UNBOOKABLE_EVENT,
  type PaymentAlertInput,
  formatMoney,
  paymentAlertDedupeKey,
  paymentAlertDetail,
  paymentAlertPayload,
  paymentAlertTitle,
  recordPaymentAlert,
} from "./payment-alerts.ts";

/**
 * 收款告警的单元面（纯函数）+ 集成面（收件人解析与 dedupe_key 幂等需要真库——
 * 部分唯一索引与 onConflictDoNothing 的行为是本切片的承重墙，必须钉住）。
 */
const databaseUrl = process.env.DATABASE_URL;

const attempt: PaymentAlertInput = {
  eventType: PAYMENT_ATTEMPT_FAILED_EVENT,
  channel: "stripe",
  externalId: "pi_3NqX1",
  reasonCode: "attempt_failed",
  reason: "card_declined — Your card was declined.",
  invoiceId: "0f0d1f6e-9c1d-4f0e-a6a7-9c1d4f0ea6a7",
  method: "card",
  amountCents: 150000,
  currency: "usd",
};

const unbookable: PaymentAlertInput = {
  eventType: PAYMENT_UNBOOKABLE_EVENT,
  channel: "paypal",
  externalId: "8XA123456",
  reasonCode: "not_issued",
  reason: "the invoice is still a draft (finance has not confirmed it)",
  invoiceId: "0f0d1f6e-9c1d-4f0e-a6a7-9c1d4f0ea6a7",
  amountCents: 49000,
  currency: null,
};

describe("payment alert copy (pure, RULE-010 English)", () => {
  it("composes the attempt-failed facts: invoice label, method, money, reason", () => {
    expect(paymentAlertTitle(attempt, "INV-0301")).toBe(
      "Payment attempt failed — invoice INV-0301 is still owed",
    );
    expect(paymentAlertDetail(attempt, "INV-0301")).toBe(
      "A customer's card attempt of USD 1,500.00 for invoice INV-0301 did not go through: " +
        "card_declined — Your card was declined. Nothing was charged; the invoice is still owed.",
    );
  });

  it("falls back to the raw invoice id and a method-less wording when facts are missing", () => {
    const bare: PaymentAlertInput = { ...attempt };
    delete bare.method;
    expect(paymentAlertDetail(bare, null)).toContain(
      `for invoice ${String(attempt.invoiceId)} did not go through`,
    );
  });

  it("composes the unbookable facts: channel, ref, money without a currency code", () => {
    expect(paymentAlertTitle(unbookable, "INV-0302")).toBe(
      "A paypal payment arrived but could not be recorded",
    );
    expect(paymentAlertDetail(unbookable, "INV-0302")).toBe(
      "A paypal payment of 490.00 (ref 8XA123456) for invoice INV-0302 arrived but could not be " +
        "recorded: the invoice is still a draft (finance has not confirmed it). " +
        "The provider will keep retrying — no money is booked until this is resolved.",
    );
  });

  it("carries the payload facts flat for the digest and the future whitelisted face", () => {
    const payload = paymentAlertPayload(unbookable, "INV-0302");
    expect(payload.title).toContain("could not be recorded");
    expect(payload.detail).toContain("still a draft");
    expect(payload.channel).toBe("paypal");
    expect(payload.externalId).toBe("8XA123456");
    expect(payload.reasonCode).toBe("not_issued");
    expect(payload.invoiceNumber).toBe("INV-0302");
    expect(payload.amountCents).toBe(49000);
    // 无币种无 method 时键整个缺席（exactOptionalPropertyTypes 的差额纪律）
    expect("currency" in payload).toBe(false);
    expect("method" in payload).toBe(false);
  });

  it("formats integer cents with thousands separators and an optional ISO currency", () => {
    expect(formatMoney(150000, "usd")).toBe("USD 1,500.00");
    expect(formatMoney(49000, null)).toBe("490.00");
    expect(formatMoney(5, "eur")).toBe("EUR 0.05");
    expect(formatMoney(123456789, null)).toBe("1,234,567.89");
  });

  it("pins the dedupe key to channel + external id, with the rejection code on unbookable only", () => {
    expect(paymentAlertDedupeKey(attempt)).toBe("pay:attempt-failed:stripe:pi_3NqX1");
    expect(paymentAlertDedupeKey(unbookable)).toBe("pay:unbookable:paypal:8XA123456:not_issued");
    const voided: PaymentAlertInput = { ...unbookable, reasonCode: "invoice_voided" };
    // 状态演变（草稿→作废）是新事实：键不同，值得新提醒
    expect(paymentAlertDedupeKey(voided)).not.toBe(paymentAlertDedupeKey(unbookable));
  });
});

describe.skipIf(!databaseUrl)("payment alert delivery (integration)", () => {
  const dbName = `payalert_test_${String(Date.now())}_${String(process.pid)}`;
  const admin = createDb(
    (() => {
      const url = new URL(databaseUrl ?? "postgres://localhost/x");
      url.pathname = "/postgres";
      return url.toString();
    })(),
  );
  const scopedUrl = (() => {
    const url = new URL(databaseUrl ?? "postgres://localhost/x");
    url.pathname = `/${dbName}`;
    return url.toString();
  })();
  const { db, pool } = createDb(scopedUrl);

  const owner = randomUUID();
  const finance = randomUUID();
  const granted = randomUUID(); // 无财务角色，走 user_permission 个人授权
  const sales = randomUUID(); // 无关角色，永不收告警

  const alert = (over: Partial<PaymentAlertInput> = {}): PaymentAlertInput => ({
    ...unbookable,
    invoiceId: null,
    ...over,
  });

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
    await db.insert(schema.authUser).values(
      [owner, finance, granted, sales].map((id, i) => ({
        id,
        name: `User ${String(i)}`,
        email: `user${String(i)}@example.com`,
        emailVerified: true,
      })),
    );
    await db.insert(schema.userRole).values([
      { userId: owner, role: "owner" },
      { userId: finance, role: "finance" },
      { userId: granted, role: "sales" },
      { userId: sales, role: "sales" },
    ]);
    await db.insert(schema.userPermission).values({ userId: granted, permission: "invoices.manage" });
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table ${schema.notifications} cascade`);
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}" with (force)`);
    await admin.pool.end();
  });

  it("fans out one row per invoices.manage holder (role defaults + individual grants), ascending", async () => {
    const alerted = await db.transaction(async (tx) => recordPaymentAlert(tx, alert()));
    expect(alerted).toEqual([granted, finance, owner].sort());
    const rows = await db.select().from(schema.notifications);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.eventType).toBe(PAYMENT_UNBOOKABLE_EVENT);
      expect(row.aggregateType).toBeNull();
      expect(row.aggregateId).toBeNull();
      expect(row.dedupeKey).toBe(paymentAlertDedupeKey(alert()));
      expect(typeof row.payload.detail).toBe("string");
    }
  });

  it("labels the alert with the invoice number and anchors the aggregate when the invoice exists", async () => {
    const invoice = (
      await db
        .insert(schema.invoices)
        .values({
          invoiceType: "sampling_fee",
          number: "INV-9001",
          status: "draft",
          currency: "USD",
          createdById: owner,
        })
        .returning({ id: schema.invoices.id })
    )[0];
    if (invoice === undefined) throw new Error("invoice seed failed");
    const input = alert({ invoiceId: invoice.id });
    await db.transaction(async (tx) => recordPaymentAlert(tx, input));
    const rows = await db.select().from(schema.notifications);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.aggregateType).toBe("invoice");
    expect(rows[0]?.aggregateId).toBe(invoice.id);
    expect(rows[0]?.payload.invoiceNumber).toBe("INV-9001");
    expect(String(rows[0]?.payload.detail)).toContain("INV-9001");
  });

  it("a redelivered fact produces zero new rows (dedupe is structural, not query-then-insert)", async () => {
    const first = await db.transaction(async (tx) => recordPaymentAlert(tx, alert()));
    expect(first.length).toBeGreaterThan(0);
    const second = await db.transaction(async (tx) => recordPaymentAlert(tx, alert()));
    expect(second).toEqual([]);
    const rows = await db.select({ n: sql<string>`count(*)` }).from(schema.notifications);
    expect(Number(rows[0]?.n ?? 0)).toBe(first.length);
  });

  it("a changed rejection state is a new fact: the same money alerts again under a new key", async () => {
    await db.transaction(async (tx) => recordPaymentAlert(tx, alert({ reasonCode: "not_issued" })));
    const alerted = await db.transaction(async (tx) =>
      recordPaymentAlert(tx, alert({ reasonCode: "invoice_voided" })),
    );
    expect(alerted.length).toBeGreaterThan(0);
    const rows = await db
      .select({ key: schema.notifications.dedupeKey })
      .from(schema.notifications);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });

  it("business rows without a dedupe key stay unconstrained by the partial index", async () => {
    await db.insert(schema.notifications).values([
      { userId: owner, eventType: "task.assigned", payload: {} },
      { userId: owner, eventType: "task.assigned", payload: {} },
    ]);
    const rows = await db
      .select({ n: sql<string>`count(*)` })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, owner));
    expect(Number(rows[0]?.n ?? 0)).toBe(2);
  });
});
