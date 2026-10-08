import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";

// 集成测试：需要真实 PostgreSQL（计划+成员票同事务、发号、生成列行合计、
// 审计）。未设 DATABASE_URL 时跳过。独立临时库（样板：routes/invoices.test.ts）。
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

function adminUrl(url: string | undefined): string {
  if (!url) return ""; // 套件被跳过时不会被用到
  const parsed = new URL(url);
  parsed.pathname = "/postgres";
  return parsed.toString();
}

interface PlanPartJson {
  invoiceId: string;
  number: string;
  planIndex: number;
  status: "draft" | "issued" | "void";
  totalCents: number;
  creditedCents: number;
  paidCents: number;
  paymentStatus: "unpaid" | "partial" | "paid";
}

interface PlanJson {
  id: string;
  label: string;
  subject: { type: string; id: string } | null;
  currency: string;
  totalCents: number;
  partCount: number;
  livePartCount: number;
  liveInvoicedCents: number;
  paidCents: number;
  outstandingCents: number;
  uninvoicedCents: number;
  parts: PlanPartJson[];
}

describe.skipIf(!databaseUrl)("invoice plan endpoints (#192 installment slice, integration)", () => {
  const dbName = `invoice_plans_test_${String(Date.now())}_${String(process.pid)}`;
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
    sendPasswordSetupEmail: async () => {},
    paypal: undefined,
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
    // 编号规则夹具：发票与贷项单各一条（无日期段，号串对日期断言免疫）
    await db.insert(schema.numberingRules).values([
      { subject: "invoice", label: "Invoice", prefix: "INV-", dateFormat: null, padding: 4, startNumber: 1000 },
      { subject: "credit_note", label: "Credit note", prefix: "CN-", dateFormat: null, padding: 4, startNumber: 5000 },
    ]);
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate table ${schema.creditNoteLines}, ${schema.creditNotes}, ${schema.invoiceLines}, ${schema.invoices}, ${schema.invoicePlans}, ${schema.payments} cascade`,
    );
    await db.execute(sql`truncate table ${schema.auditEvents}`);
    await db.execute(sql`update ${schema.numberingRules} set active = true`);
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}" with (force)`);
    await admin.pool.end();
  });

  const fin = { "x-test-user": "fin" };
  const sal = { "x-test-user": "sal" };

  async function post(path: string, headers: Record<string, string>, body?: unknown): Promise<{
    status: number;
    json: Record<string, unknown>;
  }> {
    const res = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  async function createPlan(
    body: Record<string, unknown>,
    headers: Record<string, string> = fin,
  ): Promise<{
    status: number;
    json: { id?: string; error?: string; totalCents?: number; parts?: { id: string; number: string; planIndex: number; amountCents: number }[] };
  }> {
    return post("/api/invoice-plans", headers, body);
  }

  async function getPlan(id: string, headers: Record<string, string> = fin): Promise<{
    status: number;
    json: PlanJson & { error?: string };
  }> {
    const res = await app.request(`/api/invoice-plans/${id}`, { headers });
    return { status: res.status, json: (await res.json()) as PlanJson & { error?: string } };
  }

  async function getInvoice(id: string): Promise<{
    status: number;
    json: {
      invoiceType?: string;
      status?: string;
      plan?: { id: string; index: number; count: number } | null;
      totalCents?: number;
      lines?: { description: string; lineTotalCents: number }[];
      error?: string;
    };
  }> {
    const res = await app.request(`/api/invoices/${id}`, { headers: fin });
    return { status: res.status, json: (await res.json()) as never };
  }

  it("splits an agreed amount into draft invoices in one transaction — plan read answers the cut and the live money", async () => {
    const created = await createPlan({
      label: "Season 2026 co-pay",
      subjectType: "order",
      subjectId: randomUUID(),
      parts: [{ amountCents: 400_000 }, { amountCents: 400_000 }, { amountCents: 200_000 }],
    });
    expect(created.status).toBe(201);
    expect(created.json.totalCents).toBe(1_000_000);
    const parts = created.json.parts ?? [];
    expect(parts.map((part) => part.planIndex)).toEqual([1, 2, 3]);
    expect(parts.map((part) => part.amountCents)).toEqual([400_000, 400_000, 200_000]);
    // 三期三号：发号在创建事务里逐期分配
    expect(new Set(parts.map((part) => part.number)).size).toBe(3);

    const planId = created.json.id ?? "";
    const read = await getPlan(planId);
    expect(read.status).toBe(200);
    expect(read.json.label).toBe("Season 2026 co-pay");
    expect(read.json.totalCents).toBe(1_000_000);
    expect(read.json.partCount).toBe(3);
    expect(read.json.livePartCount).toBe(3);
    expect(read.json.liveInvoicedCents).toBe(1_000_000);
    expect(read.json.uninvoicedCents).toBe(0);
    expect(read.json.paidCents).toBe(0);
    expect(read.json.outstandingCents).toBe(1_000_000);
    expect(read.json.parts.map((part) => part.status)).toEqual(["draft", "draft", "draft"]);
    expect(read.json.parts.map((part) => part.paymentStatus)).toEqual([
      "unpaid",
      "unpaid",
      "unpaid",
    ]);

    // 一次动作一行审计：计划创建带期数与全部期号
    const events = await db
      .select({ action: schema.auditEvents.action, detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "invoice_plan.created"));
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatchObject({
      label: "Season 2026 co-pay",
      totalCents: 1_000_000,
      partCount: 3,
    });
  });

  it("members are ordinary invoices — installment type, one line each, the Part i of n fact on reads", async () => {
    const created = await createPlan({
      label: "Balance split",
      parts: [{ amountCents: 700_000 }, { amountCents: 300_000 }],
    });
    const parts = created.json.parts ?? [];
    const first = await getInvoice(parts[0]?.id ?? "");
    expect(first.status).toBe(200);
    expect(first.json.invoiceType).toBe("installment");
    expect(first.json.plan).toEqual({ id: created.json.id, index: 1, count: 2 });
    expect(first.json.lines).toHaveLength(1);
    expect(first.json.lines?.[0]?.description).toBe("Balance split — installment 1 of 2");
    expect(first.json.lines?.[0]?.lineTotalCents).toBe(700_000);

    // 列表读也带同一事实（n 派生自成员数，不从行集数出来）
    const list = await app.request("/api/invoices", { headers: fin });
    const listJson = (await list.json()) as {
      invoices: { id: string; plan: { id: string; index: number; count: number } | null }[];
    };
    const listed = listJson.invoices.find((row) => row.id === parts[0]?.id);
    expect(listed?.plan).toEqual({ id: created.json.id, index: 1, count: 2 });
  });

  it("each part lives its own lifecycle — confirm, payment and the plan aggregates move per part", async () => {
    const created = await createPlan({
      label: "Balance split",
      parts: [{ amountCents: 700_000 }, { amountCents: 300_000 }],
    });
    const parts = created.json.parts ?? [];
    const confirmed = await post(`/api/invoices/${parts[0]?.id}/confirm`, fin, {
      dueInDays: 30,
    });
    expect(confirmed.status).toBe(200);
    const paid = await post(`/api/invoices/${parts[0]?.id}/payments`, fin, {
      amountCents: 700_000,
      method: "wire_ach",
      note: "wire ref 1",
    });
    expect(paid.status).toBe(201);

    const read = await getPlan(created.json.id ?? "");
    const issuedPart = read.json.parts.find((part) => part.planIndex === 1);
    const draftPart = read.json.parts.find((part) => part.planIndex === 2);
    expect(issuedPart?.status).toBe("issued");
    expect(issuedPart?.paymentStatus).toBe("paid");
    expect(draftPart?.status).toBe("draft");
    expect(draftPart?.paymentStatus).toBe("unpaid");
    // 合计只在世口径里动：已收 = 第一期；未收 = 第二期的约定额
    expect(read.json.paidCents).toBe(700_000);
    expect(read.json.outstandingCents).toBe(300_000);
    expect(read.json.liveInvoicedCents).toBe(1_000_000);
  });

  it("voiding a draft part keeps the cut facts — n counts it, live aggregates release it, uninvoiced surfaces the gap", async () => {
    const created = await createPlan({
      label: "Balance split",
      parts: [{ amountCents: 700_000 }, { amountCents: 300_000 }],
    });
    const parts = created.json.parts ?? [];
    const voided = await post(`/api/invoices/${parts[1]?.id}/void`, fin, {
      reason: "customer consolidated into part 1",
    });
    expect(voided.status).toBe(200);

    const read = await getPlan(created.json.id ?? "");
    // n 是「这刀切过的事实」：成员数含 void，序号不重排
    expect(read.json.partCount).toBe(2);
    expect(read.json.parts.map((part) => part.planIndex)).toEqual([1, 2]);
    expect(read.json.parts[1]?.status).toBe("void");
    expect(read.json.livePartCount).toBe(1);
    expect(read.json.liveInvoicedCents).toBe(700_000);
    expect(read.json.uninvoicedCents).toBe(300_000);
    expect(read.json.outstandingCents).toBe(700_000);
  });

  it("a credited member reads through the plan — effective due drives the payment status, outstanding shrinks", async () => {
    const created = await createPlan({
      label: "Balance split",
      parts: [{ amountCents: 700_000 }, { amountCents: 300_000 }],
    });
    const parts = created.json.parts ?? [];
    const first = parts[0]?.id ?? "";
    expect((await post(`/api/invoices/${first}/confirm`, fin, {})).status).toBe(200);
    const credited = await post(`/api/invoices/${first}/credit-notes`, fin, {
      reason: "scope reduced after issuing",
      lines: [{ description: "Scope reduction", quantity: 1, unitPriceCents: 700_000 }],
    });
    expect(credited.status).toBe(201);
    const noteId = (credited.json as { id?: string }).id ?? "";
    expect((await post(`/api/credit-notes/${noteId}/confirm`, fin, {})).status).toBe(200);

    const read = await getPlan(created.json.id ?? "");
    const issuedPart = read.json.parts.find((part) => part.planIndex === 1);
    // 全冲抵的票 vacuously paid——付款态与发票读写面同一条权威算术
    expect(issuedPart?.creditedCents).toBe(700_000);
    expect(issuedPart?.paymentStatus).toBe("paid");
    expect(read.json.outstandingCents).toBe(300_000);
  });

  it("draft members keep their invoice mutability — the plan read exposes the drift against the agreed cut", async () => {
    const created = await createPlan({
      label: "Balance split",
      parts: [{ amountCents: 700_000 }, { amountCents: 300_000 }],
    });
    const parts = created.json.parts ?? [];
    const patched = await app.request(`/api/invoices/${parts[0]?.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({
        lines: [{ description: "Balance split — installment 1 of 2", quantity: 1, unitPriceCents: 800_000 }],
      }),
    });
    expect(patched.status).toBe(200);

    const read = await getPlan(created.json.id ?? "");
    // 现状（80 万）超过约定（计划总额 100 万的第一期 70 万）——负数暴露，不吞
    expect(read.json.liveInvoicedCents).toBe(1_100_000);
    expect(read.json.uninvoicedCents).toBe(-100_000);
  });

  it("validation: too few or too many parts, non-positive amounts, an overflowing total, a blank label and a half subject are all 400", async () => {
    const one = await createPlan({ label: "x", parts: [{ amountCents: 100 }] });
    expect(one.status).toBe(400);
    const thirteen = await createPlan({
      label: "x",
      parts: Array.from({ length: 13 }, () => ({ amountCents: 100 })),
    });
    expect(thirteen.status).toBe(400);
    const zero = await createPlan({ label: "x", parts: [{ amountCents: 0 }, { amountCents: 100 }] });
    expect(zero.status).toBe(400);
    const overflow = await createPlan({
      label: "x",
      parts: [{ amountCents: 2_000_000_000 }, { amountCents: 2_000_000_000 }],
    });
    expect(overflow.status).toBe(400);
    const blank = await createPlan({ label: "  ", parts: [{ amountCents: 1 }, { amountCents: 1 }] });
    expect(blank.status).toBe(400);
    const halfSubject = await createPlan({
      label: "x",
      subjectType: "order",
      parts: [{ amountCents: 1 }, { amountCents: 1 }],
    });
    expect(halfSubject.status).toBe(400);
  });

  it("permission: a sales session is 403 on both the split and the plan read", async () => {
    const denied = await createPlan(
      { label: "x", parts: [{ amountCents: 1 }, { amountCents: 1 }] },
      sal,
    );
    expect(denied.status).toBe(403);
    const readDenied = await app.request(`/api/invoice-plans/${randomUUID()}`, { headers: sal });
    expect(readDenied.status).toBe(403);
  });

  it("numbering_not_configured rolls the whole plan back — no plan row, no member invoices, no numbers burned", async () => {
    await db
      .update(schema.numberingRules)
      .set({ active: false })
      .where(eq(schema.numberingRules.subject, "invoice"));
    const created = await createPlan({
      label: "Balance split",
      parts: [{ amountCents: 700_000 }, { amountCents: 300_000 }],
    });
    expect(created.status).toBe(409);
    expect(created.json.error).toBe("numbering_not_configured");
    const plans = await db.select().from(schema.invoicePlans);
    expect(plans).toHaveLength(0);
    const invoices = await db.select().from(schema.invoices);
    expect(invoices).toHaveLength(0);
    const events = await db.select().from(schema.auditEvents);
    expect(events).toHaveLength(0);
  });

  it("reads answer 404 for an unknown plan and 400 for a junk id", async () => {
    expect((await getPlan(randomUUID())).status).toBe(404);
    const junk = await app.request("/api/invoice-plans/not-a-uuid", { headers: fin });
    expect(junk.status).toBe(400);
  });
});
