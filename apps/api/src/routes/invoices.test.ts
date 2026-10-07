import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";

// 集成测试：需要真实 PostgreSQL（发号事务、行合计生成列、状态机行锁、审计）。
// 未设 DATABASE_URL 时跳过。
//
// 独立临时库（样板：routes/tasks.test.ts）——断言 audit_events 精确行数与
// invoices 的精确状态；编号规则行是本文件的夹具（truncate 不及它）。
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

interface DraftLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
}

function lineBody(description: string, quantity: number, unitPriceCents: number): DraftLine {
  return { description, quantity, unitPriceCents };
}

describe.skipIf(!databaseUrl)("invoice endpoints (#192 slice 1, integration)", () => {
  const dbName = `invoices_test_${String(Date.now())}_${String(process.pid)}`;
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
    // 编号规则夹具：无日期段（号串对日期断言免疫），padding 4
    await db.insert(schema.numberingRules).values({
      subject: "invoice",
      label: "Invoice",
      prefix: "INV-",
      dateFormat: null,
      padding: 4,
      startNumber: 1000,
    });
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table ${schema.invoiceLines}, ${schema.invoices} cascade`);
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

  interface InvoiceJson {
    id: string;
    number: string;
    invoiceType: string;
    status: "draft" | "issued" | "void";
    currency: string;
    subject: { type: string; id: string } | null;
    totalCents: number;
    issuedAt: string | null;
    voidedAt: string | null;
    voidReason: string | null;
    lines?: {
      id: string;
      description: string;
      quantity: string;
      unitPriceCents: number;
      lineTotalCents: number;
    }[];
  }

  async function createInvoice(
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<{ status: number; json: { id?: string; number?: string; error?: string } }> {
    const res = await app.request("/api/invoices", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as { id?: string; error?: string; number?: string } };
  }

  const draftBody = (lines: DraftLine[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    invoiceType: "sampling_fee",
    lines,
    ...extra,
  });

  async function seedDraft(lines: DraftLine[] = [lineBody("Prototype run", 1, 150000)]): Promise<InvoiceJson> {
    const created = await createInvoice(fin, draftBody(lines));
    if (created.status !== 201 || created.json.id === undefined) {
      throw new Error(`seedDraft failed: ${String(created.status)}`);
    }
    const res = await app.request(`/api/invoices/${created.json.id}`, { headers: fin });
    return (await res.json()) as InvoiceJson;
  }

  async function auditCount(action: string): Promise<number> {
    const rows = await db
      .select({ n: sql<string>`count(*)` })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, action));
    return Number(rows[0]?.n ?? 0);
  }

  it("creates a draft with a numbering-issued number and generated line totals", async () => {
    const created = await createInvoice(fin, draftBody([
      lineBody("Prototype run", 2.5, 100000),
      lineBody("Expedite fee", 1, 500),
    ]));
    expect(created.status).toBe(201);
    expect(created.json.number).toBe("INV-1000");
    const invoice = await seedDraft([lineBody("Second", 1, 1)]);
    // 第二张票拿下一个号（原子分配的结构性不重复）
    expect(invoice.number).toBe("INV-1001");
    const res = await app.request(`/api/invoices/${created.json.id}`, { headers: fin });
    const detail = (await res.json()) as InvoiceJson;
    expect(detail.status).toBe("draft");
    expect(detail.totalCents).toBe(250500); // 2.5×100000 + 1×500
    expect(detail.lines?.map((l) => l.lineTotalCents)).toEqual([250000, 500]);
    // quantity 从 numeric 列读回是三位小数字符串
    expect(detail.lines?.[0]?.quantity).toBe("2.500");
    expect(await auditCount("invoice.created")).toBe(2);
  });

  it("rounds half up at the cent boundary (PG numeric round on the generated column)", async () => {
    const invoice = await seedDraft([lineBody("Half cent", 0.005, 100)]);
    // 0.005 × 100 = 0.5 → round half away from zero → 1
    expect(invoice.lines?.[0]?.lineTotalCents).toBe(1);
    expect(invoice.totalCents).toBe(1);
  });

  it("rejects an empty invoice, bad quantities, and line overflow with 400", async () => {
    expect((await createInvoice(fin, draftBody([]))).status).toBe(400);
    expect((await createInvoice(fin, draftBody([lineBody("x", 0, 100)]))).status).toBe(400);
    // 4 位小数被拒（quantity 上限三位）
    expect((await createInvoice(fin, draftBody([lineBody("x", 0.0001, 100)]))).status).toBe(400);
    // 行合计超出 int4 生成列边界
    expect(
      (await createInvoice(fin, draftBody([lineBody("x", 999999999, 2000000000)]))).status,
    ).toBe(400);
    // subject / source 两键必须成对
    expect(
      (await createInvoice(fin, draftBody([lineBody("x", 1, 1)], { subjectType: "quote" }))).status,
    ).toBe(400);
    expect(await auditCount("invoice.created")).toBe(0);
  });

  it("is idempotent per trigger source and tolerant of manual tickets", async () => {
    const source = { sourceType: "quote_accepted", sourceKey: "q-123" };
    const first = await createInvoice(fin, draftBody([lineBody("Deposit", 1, 5000000)], source));
    expect(first.status).toBe(201);
    const second = await createInvoice(fin, draftBody([lineBody("Deposit", 1, 5000000)], source));
    expect(second.status).toBe(409);
    expect(second.json.error).toBe("invoice_exists");
    // 不同 sourceKey 互不挡；手工票（无 source）可反复开
    expect(
      (
        await createInvoice(fin, draftBody([lineBody("Deposit", 1, 1)], {
          sourceType: "quote_accepted",
          sourceKey: "q-456",
        }))
      ).status,
    ).toBe(201);
    expect((await createInvoice(fin, draftBody([lineBody("Manual", 1, 1)]))).status).toBe(201);
    expect((await createInvoice(fin, draftBody([lineBody("Manual 2", 1, 1)]))).status).toBe(201);
  });

  it("fails closed when no numbering rule is active (409 numbering_not_configured)", async () => {
    await db.delete(schema.numberingSequences);
    await db.delete(schema.numberingRules);
    const res = await createInvoice(fin, draftBody([lineBody("x", 1, 1)]));
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("numbering_not_configured");
    expect(await auditCount("invoice.created")).toBe(0);
    // 恢复夹具规则（beforeEach 不清 numbering_rules，本用例自清自建）
    await db.insert(schema.numberingRules).values({
      subject: "invoice",
      label: "Invoice",
      prefix: "INV-",
      dateFormat: null,
      padding: 4,
      startNumber: 1000,
    });
    expect((await createInvoice(fin, draftBody([lineBody("x", 1, 1)]))).status).toBe(201);
  });

  it("replaces draft lines wholesale, is no-op idempotent on identical lines", async () => {
    const invoice = await seedDraft();
    const sameLines = [lineBody("Prototype run", 1, 150000)];
    const identical = await app.request(`/api/invoices/${invoice.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({ lines: sameLines }),
    });
    expect(identical.status).toBe(200);
    expect(await auditCount("invoice.updated")).toBe(0);
    const changed = await app.request(`/api/invoices/${invoice.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({ lines: [lineBody("Prototype run", 3, 150000)] }),
    });
    expect(changed.status).toBe(200);
    expect(await auditCount("invoice.updated")).toBe(1);
    const res = await app.request(`/api/invoices/${invoice.id}`, { headers: fin });
    const detail = (await res.json()) as InvoiceJson;
    expect(detail.totalCents).toBe(450000);
    expect(detail.lines).toHaveLength(1);
  });

  it("confirms a draft: issued state, audit with total, idempotent repeat", async () => {
    const invoice = await seedDraft([lineBody("Deposit", 1, 5000000)]);
    const res = await app.request(`/api/invoices/${invoice.id}/confirm`, {
      method: "POST",
      headers: fin,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("issued");
    const repeat = await app.request(`/api/invoices/${invoice.id}/confirm`, {
      method: "POST",
      headers: fin,
    });
    expect(repeat.status).toBe(200);
    expect(((await repeat.json()) as { status: string }).status).toBe("already");
    expect(await auditCount("invoice.confirmed")).toBe(1);
    const events = await db
      .select({ detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "invoice.confirmed"));
    expect(events[0]?.detail).toMatchObject({ number: invoice.number, totalCents: 5000000 });
    const detailRes = await app.request(`/api/invoices/${invoice.id}`, { headers: fin });
    const detail = (await detailRes.json()) as InvoiceJson;
    expect(detail.status).toBe("issued");
    expect(detail.issuedAt).not.toBeNull();
  });

  it("voids a draft with reason; issued invoices are not voidable; repeat is idempotent", async () => {
    const invoice = await seedDraft();
    const res = await app.request(`/api/invoices/${invoice.id}/void`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({ reason: "duplicate of INV-1000" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("voided");
    expect(await auditCount("invoice.voided")).toBe(1);
    const repeat = await app.request(`/api/invoices/${invoice.id}/void`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({ reason: "again" }),
    });
    expect(repeat.status).toBe(200);
    expect(((await repeat.json()) as { status: string }).status).toBe("already");
    expect(await auditCount("invoice.voided")).toBe(1);

    // issued 票不可作废（红冲是后续切片的动词）；void 票不可确认
    const issued = await seedDraft();
    await app.request(`/api/invoices/${issued.id}/confirm`, { method: "POST", headers: fin });
    const voidIssued = await app.request(`/api/invoices/${issued.id}/void`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({}),
    });
    expect(voidIssued.status).toBe(409);
    expect(((await voidIssued.json()) as { error: string }).error).toBe("not_voidable");

    const voided = await seedDraft();
    await app.request(`/api/invoices/${voided.id}/void`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({}),
    });
    const confirmVoided = await app.request(`/api/invoices/${voided.id}/confirm`, {
      method: "POST",
      headers: fin,
    });
    expect(confirmVoided.status).toBe(409);
    expect(((await confirmVoided.json()) as { error: string }).error).toBe("invoice_voided");
  });

  it("rejects line edits after the invoice left draft (409 not_draft)", async () => {
    const invoice = await seedDraft();
    await app.request(`/api/invoices/${invoice.id}/confirm`, { method: "POST", headers: fin });
    const patch = await app.request(`/api/invoices/${invoice.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({ lines: [lineBody("Sneaky", 1, 1)] }),
    });
    expect(patch.status).toBe(409);
    expect(((await patch.json()) as { error: string }).error).toBe("not_draft");
    const detailRes = await app.request(`/api/invoices/${invoice.id}`, { headers: fin });
    const detail = (await detailRes.json()) as InvoiceJson;
    // 行没被改：已发行的票的金额在状态机上锁定
    expect(detail.totalCents).toBe(150000);
  });

  it("returns 404 for unknown invoices on every verb", async () => {
    const missing = randomUUID();
    expect((await app.request(`/api/invoices/${missing}`, { headers: fin })).status).toBe(404);
    expect(
      (
        await app.request(`/api/invoices/${missing}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", ...fin },
          body: JSON.stringify({ lines: [lineBody("x", 1, 1)] }),
        })
      ).status,
    ).toBe(404);
    expect(
      (await app.request(`/api/invoices/${missing}/confirm`, { method: "POST", headers: fin })).status,
    ).toBe(404);
    expect(
      (await app.request(`/api/invoices/${missing}/void`, { method: "POST", headers: fin })).status,
    ).toBe(404);
  });

  it("lists invoices with totals and a status filter", async () => {
    await seedDraft();
    const issued = await seedDraft();
    await app.request(`/api/invoices/${issued.id}/confirm`, { method: "POST", headers: fin });
    const all = await app.request("/api/invoices", { headers: fin });
    expect(((await all.json()) as { invoices: InvoiceJson[] }).invoices).toHaveLength(2);
    const drafts = await app.request("/api/invoices?status=draft", { headers: fin });
    const draftList = (await drafts.json()) as { invoices: InvoiceJson[] };
    expect(draftList.invoices).toHaveLength(1);
    expect(draftList.invoices[0]?.status).toBe("draft");
    expect(draftList.invoices[0]?.totalCents).toBe(150000);
    const issuedList = await app.request("/api/invoices?status=issued", { headers: fin });
    expect(((await issuedList.json()) as { invoices: InvoiceJson[] }).invoices).toHaveLength(1);
  });

  it("gates every verb behind invoices.manage (sales 403, owner passes)", async () => {
    for (
      const attempt of [
        () => createInvoice(sal, draftBody([lineBody("x", 1, 1)])),
        async () => ({ status: (await app.request("/api/invoices", { headers: sal })).status }),
        async () => ({ status: (await app.request(`/api/invoices/${randomUUID()}`, { headers: sal })).status }),
        async () => ({
          status: (
            await app.request(`/api/invoices/${randomUUID()}`, {
              method: "PATCH",
              headers: { "content-type": "application/json", ...sal },
              body: JSON.stringify({ lines: [lineBody("x", 1, 1)] }),
            })
          ).status,
        }),
        async () => ({
          status: (await app.request(`/api/invoices/${randomUUID()}/confirm`, { method: "POST", headers: sal })).status,
        }),
        async () => ({
          status: (await app.request(`/api/invoices/${randomUUID()}/void`, { method: "POST", headers: sal })).status,
        }),
      ]
    ) {
      const res = await attempt();
      expect(res.status).toBe(403);
    }
    expect(await auditCount("invoice.created")).toBe(0);
    // owner 默认持有同一权限点（#232 §12「全部查看」+ 财务同权的管理面）
    expect((await createInvoice(own, draftBody([lineBody("Owner", 1, 1)]))).status).toBe(201);
  });

  it("404s (not 403) for unauthenticated callers through the session gate", async () => {
    const res = await app.request("/api/invoices");
    expect([401, 403]).toContain(res.status);
  });
});

function adminUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) return ""; // 套件被跳过时不会被用到
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}
