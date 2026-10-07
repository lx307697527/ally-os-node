import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";

// 集成测试：需要真实 PostgreSQL（发票行锁、收款 SUM、幂等唯一索引、审计）。
// 未设 DATABASE_URL 时跳过。
//
// 独立临时库（样板：routes/invoices.test.ts）——断言 audit_events 精确行数与
// payments 的精确行数；编号规则行是本文件的夹具（truncate 不及它）。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

/** fin = 财务（invoices.manage 默认持有），own = 老板，sal = 销售（无权限点） */
const USERS = {
  fin: randomUUID(),
  own: randomUUID(),
  sal: randomUUID(),
} as const;

type UserName = keyof typeof USERS;

function sessionFor(userId: string, name: string): SessionData {
  const displayName = name.charAt(0).toUpperCase() + name.slice(1);
  return {
    user: {
      id: userId,
      email: `${name}@example.com`,
      name: displayName,
      emailVerified: true,
      twoFactorEnabled: true,
    },
    session: { id: `s-${userId}`, userId, expiresAt: new Date(Date.now() + 3_600_000) },
  };
}

describe.skipIf(!databaseUrl)("payment endpoints (#192 slice 2, integration)", () => {
  const dbName = `payments_test_${String(Date.now())}_${String(process.pid)}`;
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

  const app = createApp({
    stripe: undefined,
    logger,
    db,
    corsOrigins: ["http://localhost:5173"],
    checkDatabase: async () => {
      await pool.query("select 1");
    },
    authHandler: () => Promise.reject(new Error("auth handler should not be called")),
    resolveSession: (headers) => {
      const who = headers.get("x-test-user");
      if (who === null || !(who in USERS)) return Promise.resolve(null);
      const name = who as UserName;
      return Promise.resolve(sessionFor(USERS[name], name));
    },
    socialProviders: [],
    storage: {
      put: () => Promise.reject(new Error("storage not used in this suite")),
      signedGetUrl: () => Promise.reject(new Error("storage not used in this suite")),
      signedPutUrl: () => Promise.reject(new Error("storage not used in this suite")),
      delete: () => Promise.reject(new Error("storage not used in this suite")),
    },
    authzStore: {
      getRoles: (userId) =>
        Promise.resolve(
          userId === USERS.fin ? ["finance"] : userId === USERS.own ? ["owner"] : ["sales"],
        ),
      getDirectPermissions: () => Promise.resolve([]),
      grantRole: () => Promise.reject(new Error("not used")),
      revokeRole: () => Promise.reject(new Error("not used")),
    },
    notifyUsers: () => Promise.resolve(),
  });

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
    await db.insert(schema.authUser).values(
      (Object.keys(USERS) as UserName[]).map((name) => ({
        id: USERS[name],
        name: name.charAt(0).toUpperCase() + name.slice(1),
        email: `${name}@example.com`,
        emailVerified: true,
      })),
    );
    await db.insert(schema.userRole).values([
      { userId: USERS.fin, role: "finance" },
      { userId: USERS.own, role: "owner" },
      { userId: USERS.sal, role: "sales" },
    ]);
    // 编号规则夹具：无日期段（号串对日期断言免疫），padding 4
    await db.insert(schema.numberingRules).values({
      subject: "invoice",
      label: "Invoice",
      prefix: "INV-",
      dateFormat: null,
      padding: 4,
      startNumber: 2000,
    });
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table ${schema.payments}, ${schema.invoiceLines}, ${schema.invoices} cascade`);
    await db.execute(sql`truncate table ${schema.auditEvents}`);
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}" with (force)`);
    await admin.pool.end();
  });

  const fin = { "x-test-user": "fin" };
  const own = { "x-test-user": "own" };
  const sal = { "x-test-user": "sal" };

  interface PaymentJson {
    id: string;
    method: string;
    amountCents: number;
    currency: string;
    receivedAt: string;
    note: string | null;
    voidedAt: string | null;
    voidReason: string | null;
  }

  interface LedgerJson {
    totalCents: number;
    paidCents: number;
    paymentStatus: "unpaid" | "partial" | "paid";
    payments: PaymentJson[];
  }

  interface InvoiceJson {
    id: string;
    number: string;
    status: "draft" | "issued" | "void";
    totalCents: number;
    paidCents: number;
    paymentStatus: "unpaid" | "partial" | "paid";
  }

  /** 建一张草稿并确认发出（收款的唯一合法前提），返回票面 */
  async function seedIssuedInvoice(
    lines: { description: string; quantity: number; unitPriceCents: number }[] = [
      { description: "Prototype run", quantity: 1, unitPriceCents: 150000 },
    ],
  ): Promise<InvoiceJson> {
    const created = await app.request("/api/invoices", {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({ invoiceType: "sampling_fee", lines }),
    });
    if (created.status !== 201) {
      throw new Error(`seedIssuedInvoice create failed: ${String(created.status)}`);
    }
    const { id } = (await created.json()) as { id: string };
    const confirmed = await app.request(`/api/invoices/${id}/confirm`, {
      method: "POST",
      headers: fin,
    });
    if (confirmed.status !== 200) {
      throw new Error(`seedIssuedInvoice confirm failed: ${String(confirmed.status)}`);
    }
    const res = await app.request(`/api/invoices/${id}`, { headers: fin });
    return (await res.json()) as InvoiceJson;
  }

  async function recordPayment(
    invoiceId: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = fin,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await app.request(`/api/invoices/${invoiceId}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  async function auditCount(action: string): Promise<number> {
    const rows = await db
      .select({ n: sql<string>`count(*)` })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, action));
    return Number(rows[0]?.n ?? 0);
  }

  it("records a manual payment: partial then paid, ledger and audit agree", async () => {
    const invoice = await seedIssuedInvoice();
    expect(invoice.totalCents).toBe(150000);
    expect(invoice.paymentStatus).toBe("unpaid");

    const first = await recordPayment(invoice.id, { amountCents: 100000, method: "wire_ach" });
    expect(first.status).toBe(201);
    expect(first.json.paymentStatus).toBe("partial");
    expect(first.json.paidCents).toBe(100000);

    const second = await recordPayment(invoice.id, {
      amountCents: 50000,
      method: "card",
      note: "balance by card",
    });
    expect(second.status).toBe(201);
    expect(second.json).toMatchObject({ paymentStatus: "paid", paidCents: 150000 });

    const ledger = await app.request(`/api/invoices/${invoice.id}/payments`, { headers: fin });
    expect(ledger.status).toBe(200);
    const body = (await ledger.json()) as LedgerJson;
    expect(body.paymentStatus).toBe("paid");
    expect(body.paidCents).toBe(150000);
    expect(body.payments).toHaveLength(2);
    expect(body.payments.map((p) => p.method)).toEqual(["wire_ach", "card"]);
    // currency 从发票行抄录（收款行自描述）
    expect(body.payments.every((p) => p.currency === "USD")).toBe(true);

    const detail = await app.request(`/api/invoices/${invoice.id}`, { headers: fin });
    expect(((await detail.json()) as InvoiceJson).paymentStatus).toBe("paid");

    expect(await auditCount("payment.recorded")).toBe(2);
    expect(await auditCount("payment.voided")).toBe(0);
  });

  it("is idempotent per webhook source and tolerant of manual entries", async () => {
    const invoice = await seedIssuedInvoice();
    const source = { sourceType: "stripe", sourceKey: "evt_123" };
    const first = await recordPayment(invoice.id, { amountCents: 1000, method: "card", ...source });
    expect(first.status).toBe(201);
    // 同一 webhook 事件重放：409（webhook 层 #193 把它当已记账成功）
    const replay = await recordPayment(invoice.id, { amountCents: 1000, method: "card", ...source });
    expect(replay.status).toBe(409);
    expect(replay.json.error).toBe("payment_exists");
    // 不同 sourceKey 互不挡；手工行（无 source）不受约束
    expect(
      (
        await recordPayment(invoice.id, {
          amountCents: 1000,
          method: "paypal",
          sourceType: "paypal",
          sourceKey: "CAPTURE-9",
        })
      ).status,
    ).toBe(201);
    expect((await recordPayment(invoice.id, { amountCents: 500, method: "wire_ach" })).status).toBe(201);
    expect((await recordPayment(invoice.id, { amountCents: 500, method: "wire_ach" })).status).toBe(201);
    const rows = await db.select({ n: sql<string>`count(*)` }).from(schema.payments);
    expect(Number(rows[0]?.n ?? 0)).toBe(4);
  });

  it("refuses money on invoices finance has not issued (fail closed, no auto-advance)", async () => {
    // draft：财务确认前到账不替财务放行（R-12-6，老系统自动跳 sent 被抛弃）
    const created = await app.request("/api/invoices", {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({
        invoiceType: "sampling_fee",
        lines: [{ description: "Draft", quantity: 1, unitPriceCents: 10000 }],
      }),
    });
    const draft = (await created.json()) as { id: string };
    const onDraft = await recordPayment(draft.id, { amountCents: 10000, method: "card" });
    expect(onDraft.status).toBe(409);
    expect(onDraft.json.error).toBe("not_issued");

    // void：作废的票不可收钱
    await app.request(`/api/invoices/${draft.id}/void`, { method: "POST", headers: fin });
    const onVoid = await recordPayment(draft.id, { amountCents: 10000, method: "card" });
    expect(onVoid.status).toBe(409);
    expect(onVoid.json.error).toBe("invoice_voided");

    expect(await auditCount("payment.recorded")).toBe(0);
  });

  it("rejects malformed payments with 400", async () => {
    const invoice = await seedIssuedInvoice();
    expect((await recordPayment(invoice.id, { amountCents: 0, method: "card" })).status).toBe(400);
    expect((await recordPayment(invoice.id, { amountCents: -5, method: "card" })).status).toBe(400);
    expect((await recordPayment(invoice.id, { amountCents: 10.5, method: "card" })).status).toBe(400);
    expect((await recordPayment(invoice.id, { amountCents: 100, method: "check" })).status).toBe(400);
    // 到账时刻不许未来（到账是过去的事实）
    expect(
      (
        await recordPayment(invoice.id, {
          amountCents: 100,
          method: "card",
          receivedAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
      ).status,
    ).toBe(400);
    // source 两键必须成对
    expect(
      (await recordPayment(invoice.id, { amountCents: 100, method: "card", sourceType: "stripe" })).status,
    ).toBe(400);
    expect(await auditCount("payment.recorded")).toBe(0);
  });

  it("accepts a past receivedAt for wire entries and stores it verbatim", async () => {
    const invoice = await seedIssuedInvoice();
    const yesterday = new Date(Date.now() - 86_400_000);
    const res = await recordPayment(invoice.id, {
      amountCents: 150000,
      method: "wire_ach",
      receivedAt: yesterday.toISOString(),
      note: "wire ref W-88",
    });
    expect(res.status).toBe(201);
    const ledger = (await (
      await app.request(`/api/invoices/${invoice.id}/payments`, { headers: fin })
    ).json()) as LedgerJson;
    expect(new Date(ledger.payments[0]?.receivedAt ?? "").getTime()).toBe(yesterday.getTime());
    expect(ledger.payments[0]?.note).toBe("wire ref W-88");
  });

  it("voids a mis-recorded payment: excluded from sums, demotes status, audit once", async () => {
    const invoice = await seedIssuedInvoice();
    await recordPayment(invoice.id, { amountCents: 100000, method: "card" });
    const wrong = await recordPayment(invoice.id, { amountCents: 999999, method: "wire_ach" });
    expect(wrong.json.paymentStatus).toBe("paid"); // 超收是事实，先记账
    const paymentId = wrong.json.id as string;

    // reason 必填（更正要说清楚为什么）
    const noReason = await app.request(`/api/payments/${paymentId}/void`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({}),
    });
    expect(noReason.status).toBe(400);

    const voided = await app.request(`/api/payments/${paymentId}/void`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({ reason: "wrong wire amount, typo" }),
    });
    expect(voided.status).toBe(200);
    const voidBody = (await voided.json()) as { status: string; paidCents: number; paymentStatus: string };
    expect(voidBody.status).toBe("voided");
    expect(voidBody).toMatchObject({ paidCents: 100000, paymentStatus: "partial" });

    // 台账里行还在（钱行永不删），但 SUM 剔除
    const ledger = (await (
      await app.request(`/api/invoices/${invoice.id}/payments`, { headers: fin })
    ).json()) as LedgerJson;
    expect(ledger.payments).toHaveLength(2);
    expect(ledger.paidCents).toBe(100000);
    expect(ledger.paymentStatus).toBe("partial");

    // 重复作废幂等：already、审计不落第二行
    const again = await app.request(`/api/payments/${paymentId}/void`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({ reason: "second click" }),
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { status: string }).status).toBe("already");
    expect(await auditCount("payment.voided")).toBe(1);

    // 再补一张正确金额的卡收款可回到 paid（void 后发票继续收款）
    const retry = await recordPayment(invoice.id, { amountCents: 50000, method: "card" });
    expect(retry.json.paymentStatus).toBe("paid");
  });

  it("enforces invoices.manage and 404s unknown records", async () => {
    const invoice = await seedIssuedInvoice();
    // sales 无权限点：三条路由全部 403
    expect((await recordPayment(invoice.id, { amountCents: 100, method: "card" }, sal)).status).toBe(403);
    expect(
      (await app.request(`/api/invoices/${invoice.id}/payments`, { headers: sal })).status,
    ).toBe(403);
    expect(
      (
        await app.request(`/api/payments/${randomUUID()}/void`, {
          method: "POST",
          headers: { "content-type": "application/json", ...sal },
          body: JSON.stringify({ reason: "x" }),
        })
      ).status,
    ).toBe(403);
    // owner 持有 invoices.manage，可以记账
    expect((await recordPayment(invoice.id, { amountCents: 100, method: "card" }, own)).status).toBe(201);

    // 404：票不存在 / 款不存在（反探测，与发票详情同裁）
    expect((await recordPayment(randomUUID(), { amountCents: 100, method: "card" })).status).toBe(404);
    expect((await app.request(`/api/invoices/${randomUUID()}/payments`, { headers: fin })).status).toBe(404);
    expect(
      (
        await app.request(`/api/payments/${randomUUID()}/void`, {
          method: "POST",
          headers: { "content-type": "application/json", ...fin },
          body: JSON.stringify({ reason: "x" }),
        })
      ).status,
    ).toBe(404);
  });

  it("treats a zero-total invoice as settled (nothing to collect)", async () => {
    const invoice = await seedIssuedInvoice([
      { description: "Courtesy line", quantity: 1, unitPriceCents: 0 },
    ]);
    expect(invoice.totalCents).toBe(0);
    expect(invoice.paymentStatus).toBe("paid");
  });

  it("surfaces payment status in the invoice list read", async () => {
    const paid = await seedIssuedInvoice([
      { description: "Small", quantity: 1, unitPriceCents: 5000 },
    ]);
    await recordPayment(paid.id, { amountCents: 5000, method: "card" });
    const unpaid = await seedIssuedInvoice([
      { description: "Big", quantity: 2, unitPriceCents: 70000 },
    ]);
    const list = await app.request("/api/invoices", { headers: fin });
    const body = (await list.json()) as { invoices: InvoiceJson[] };
    const byId = new Map(body.invoices.map((row) => [row.id, row]));
    expect(byId.get(paid.id)?.paymentStatus).toBe("paid");
    expect(byId.get(unpaid.id)?.paymentStatus).toBe("unpaid");
    expect(byId.get(unpaid.id)?.paidCents).toBe(0);
  });
});

/** 未设 DATABASE_URL 时的占位（套件整体 skip，不执行） */
function adminUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) return ""; // 套件被跳过时不会被用到
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}
