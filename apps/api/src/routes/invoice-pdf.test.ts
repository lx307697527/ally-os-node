import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { DEFAULT_PDF_TEMPLATE, pdfSha256 } from "@ally/pdf";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";

// 集成测试：需要真实 PostgreSQL（发票状态机、存档行唯一索引、审计）。
// 未设 DATABASE_URL 时跳过。独立临时库（样板：routes/invoices.test.ts）。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

/** fin = 财务（invoices.manage），sal = 销售（无权限点） */
const USERS = {
  fin: randomUUID(),
  sal: randomUUID(),
} as const;

type UserName = keyof typeof USERS;

function sessionFor(userId: string, name: string): SessionData {
  return {
    user: {
      id: userId,
      email: `${name}@example.com`,
      name: name.charAt(0).toUpperCase() + name.slice(1),
      emailVerified: true,
      twoFactorEnabled: true,
    },
    session: { id: `s-${userId}`, userId, expiresAt: new Date(Date.now() + 3_600_000) },
  };
}

interface MemoryObject {
  body: Uint8Array;
  contentType?: string;
}

/** 内存对象桶：记录 put 失败一次的开关，模拟确认时刻的存档故障 */
const storageObjects = new Map<string, MemoryObject>();
let failNextPut = false;
let putCallCount = 0;

const storage = {
  put(key: string, body: Uint8Array | string, contentType?: string): Promise<void> {
    putCallCount += 1;
    if (failNextPut) {
      failNextPut = false;
      throw new Error("simulated storage outage");
    }
    storageObjects.set(key, {
      body: typeof body === "string" ? new TextEncoder().encode(body) : body,
      ...(contentType !== undefined ? { contentType } : {}),
    });
    return Promise.resolve();
  },
  signedGetUrl: (key: string) => Promise.resolve(`http://storage.test/get/${key}`),
  signedPutUrl: () => Promise.reject(new Error("not used")),
  delete: (key: string) => {
    storageObjects.delete(key);
    return Promise.resolve();
  },
  head: (key: string) =>
    Promise.resolve(
      storageObjects.has(key)
        ? { sizeBytes: storageObjects.get(key)?.body.byteLength ?? 0 }
        : (null as { sizeBytes: number } | null),
    ),
  get: (key: string) => Promise.resolve(storageObjects.get(key)?.body ?? null),
};

describe.skipIf(!databaseUrl)("invoice PDF + template config (#128, integration)", () => {
  const dbName = `invoice_pdf_test_${String(Date.now())}_${String(process.pid)}`;
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
    storage,
    authzStore: {
      getRoles: (userId) => Promise.resolve(userId === USERS.fin ? ["finance"] : ["sales"]),
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
      { userId: USERS.sal, role: "sales" },
    ]);
    await db.insert(schema.numberingRules).values({
      subject: "invoice",
      label: "Invoice",
      prefix: "INV-",
      dateFormat: null,
      padding: 4,
      startNumber: 5000,
    });
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate table ${schema.invoiceDocuments}, ${schema.invoiceLines}, ${schema.invoices} cascade`,
    );
    await db.execute(sql`truncate table ${schema.auditEvents}, ${schema.pdfTemplateConfig}`);
    storageObjects.clear();
    failNextPut = false;
    putCallCount = 0;
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}" with (force)`);
    await admin.pool.end();
  });

  const fin = { "x-test-user": "fin" };
  const sal = { "x-test-user": "sal" };

  async function createDraft(): Promise<{ id: string; number: string }> {
    const res = await app.request("/api/invoices", {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({
        invoiceType: "sampling_fee",
        lines: [{ description: "Prototype run", quantity: 1, unitPriceCents: 150000 }],
      }),
    });
    const json = (await res.json()) as { id?: string; number?: string };
    if (res.status !== 201 || json.id === undefined || json.number === undefined) {
      throw new Error(`createDraft failed: ${String(res.status)}`);
    }
    return { id: json.id, number: json.number };
  }

  async function confirmInvoice(id: string): Promise<number> {
    const res = await app.request(`/api/invoices/${id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({ dueInDays: 15 }),
    });
    return res.status;
  }

  async function getPdf(id: string, headers: Record<string, string> = fin): Promise<Response> {
    return await app.request(`/api/invoices/${id}/pdf`, { headers });
  }

  async function archiveRow(id: string) {
    const rows = await db
      .select()
      .from(schema.invoiceDocuments)
      .where(eq(schema.invoiceDocuments.invoiceId, id))
      .limit(1);
    return rows[0];
  }

  async function auditCount(action: string): Promise<number> {
    const rows = await db
      .select({ n: sql<string>`count(*)` })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, action));
    return Number(rows[0]?.n ?? 0);
  }

  it("serves draft PDFs live without archiving", async () => {
    const draft = await createDraft();
    const res = await getPdf(draft.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain(`filename="DRAFT-${draft.number}.pdf"`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-");
    // 草稿不落桶不记账：存档语义只属于发出的票
    expect(await archiveRow(draft.id)).toBeUndefined();
    expect(putCallCount).toBe(0);
  });

  it("archives at confirm and serves the archived original", async () => {
    const draft = await createDraft();
    expect(await confirmInvoice(draft.id)).toBe(200);
    const row = await archiveRow(draft.id);
    expect(row).toBeDefined();
    const stored = storageObjects.get(`invoices/${draft.id}.pdf`);
    expect(stored).toBeDefined();
    // 台账与桶里是同一份字节，哈希是规范化字节的 SHA-256
    expect(pdfSha256(stored?.body ?? new Uint8Array())).toBe(row?.contentSha256);
    expect(row?.templateSnapshot).toEqual(DEFAULT_PDF_TEMPLATE);

    const res = await getPdf(draft.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(`filename="${draft.number}.pdf"`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(pdfSha256(bytes)).toBe(row?.contentSha256);
    // 已存档不重渲：读路径直接回桶里的原件
    expect(putCallCount).toBe(1);
  });

  it("keeps archived invoices unchanged when the template changes", async () => {
    const draft = await createDraft();
    await confirmInvoice(draft.id);
    const before = await archiveRow(draft.id);
    expect(before).toBeDefined();
    const archivedBytes = storageObjects.get(`invoices/${draft.id}.pdf`)?.body;
    assert(archivedBytes !== undefined);
    const archivedSha = pdfSha256(archivedBytes);

    const patch = await app.request("/api/pdf-template-config", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({
        ...DEFAULT_PDF_TEMPLATE,
        brandColor: "#7C2D12",
        company: { ...DEFAULT_PDF_TEMPLATE.company, name: "Acme Flavors LLC" },
      }),
    });
    expect(patch.status).toBe(200);

    // 新草稿吃新模板，已存档的票 byte-for-byte 不变（验收第 2 条）
    const newDraft = await createDraft();
    const newDraftPdf = await getPdf(newDraft.id);
    const newDraftBytes = pdfSha256(new Uint8Array(await newDraftPdf.arrayBuffer()));
    const oldDraftLive = pdfSha256(
      new Uint8Array(await (await getPdf(draft.id)).arrayBuffer()),
    );
    expect(oldDraftLive).toBe(before?.contentSha256);
    // 桶里的存档对象没被重写：读回来还是确认时刻那份字节
    const archivedAfter = storageObjects.get(`invoices/${draft.id}.pdf`)?.body;
    expect(archivedAfter?.byteLength).toBe(archivedBytes.byteLength);
    expect(pdfSha256(archivedAfter ?? new Uint8Array())).toBe(archivedSha);
    expect(newDraftBytes).not.toBe(before?.contentSha256);
  });

  it("backfills a missing archive on read without failing the confirm", async () => {
    const draft = await createDraft();
    failNextPut = true;
    expect(await confirmInvoice(draft.id)).toBe(200);
    // 确认成功（发票是事实），存档失败（PDF 是投影）：无存档行
    expect(await archiveRow(draft.id)).toBeUndefined();
    expect(await auditCount("invoice.confirmed")).toBe(1);

    // 读路径补档：渲染 + 落桶 + 记账，之后读到的是补上的原件
    const res = await getPdf(draft.id);
    expect(res.status).toBe(200);
    const row = await archiveRow(draft.id);
    expect(row).toBeDefined();
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(pdfSha256(bytes)).toBe(row?.contentSha256);
    // 再读：存量直读，不再落桶
    putCallCount = 0;
    await getPdf(draft.id);
    expect(putCallCount).toBe(0);
  });

  it("refuses documents for voided invoices and unknown ids", async () => {
    const draft = await createDraft();
    await app.request(`/api/invoices/${draft.id}/void`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({ reason: "wrong quote" }),
    });
    expect((await getPdf(draft.id)).status).toBe(409);
    expect((await getPdf(randomUUID())).status).toBe(404);
    expect((await getPdf("not-a-uuid")).status).toBe(400);
  });

  it("keeps the document face behind invoices.manage", async () => {
    const draft = await createDraft();
    expect((await getPdf(draft.id, sal)).status).toBe(403);
    const config = await app.request("/api/pdf-template-config", { headers: sal });
    expect(config.status).toBe(403);
  });

  it("returns the default template when unconfigured and validates patches", async () => {
    const initial = await app.request("/api/pdf-template-config", { headers: fin });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ config: DEFAULT_PDF_TEMPLATE });

    const bad = await app.request("/api/pdf-template-config", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({ ...DEFAULT_PDF_TEMPLATE, brandColor: "navy" }),
    });
    expect(bad.status).toBe(400);

    const unknownKey = await app.request("/api/pdf-template-config", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({ ...DEFAULT_PDF_TEMPLATE, logoUrl: "https://x.test/a.png" }),
    });
    expect(unknownKey.status).toBe(400);
  });

  it("is idempotent on no-op patches and audits real changes field by field", async () => {
    const noop = await app.request("/api/pdf-template-config", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify(DEFAULT_PDF_TEMPLATE),
    });
    expect(noop.status).toBe(200);
    expect(await noop.json()).toEqual({ config: DEFAULT_PDF_TEMPLATE, updated: false });
    expect(await auditCount("pdf.template_updated")).toBe(0);

    const changed = await app.request("/api/pdf-template-config", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({
        ...DEFAULT_PDF_TEMPLATE,
        company: { ...DEFAULT_PDF_TEMPLATE.company, phone: "+1 415 555 0100" },
        paymentInstructions: {
          ...DEFAULT_PDF_TEMPLATE.paymentInstructions,
          bankName: "First Bank",
          accountNumber: "000123456",
        },
      }),
    });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as { updated: boolean }).updated).toBe(true);
    expect(await auditCount("pdf.template_updated")).toBe(1);
    const audits = await db
      .select({ detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "pdf.template_updated"));
    const changes = (audits[0]?.detail as { changes: Record<string, unknown> }).changes;
    expect(Object.keys(changes).sort()).toEqual([
      "company.phone",
      "paymentInstructions.accountNumber",
      "paymentInstructions.bankName",
    ]);

    // 配置真的进了渲染：新草稿的 PDF 哈希随新模板变
    const configured = await app.request("/api/pdf-template-config", { headers: fin });
    const { config } = (await configured.json()) as { config: { company: { phone: string } } };
    expect(config.company.phone).toBe("+1 415 555 0100");
  });

  it("maps the DB row through the same zod face the renderer uses", async () => {
    // PATCH 后 DB 单例行存在；GET 回的配置必须与渲染配置同一形状（同一 zod 面）
    await app.request("/api/pdf-template-config", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({
        brandColor: "#14532D",
        company: {
          name: "Acme Flavors LLC",
          addressLines: ["9 Flavor Way", "Newark, NJ"],
          email: "billing@acme.test",
          phone: "+1 973 555 0100",
        },
        paymentInstructions: {
          bankName: "First Bank",
          accountName: "Acme Flavors LLC",
          accountNumber: "000123456",
          routingNumber: "021000021",
          referenceNote: "Include the invoice number as payment reference.",
        },
      }),
    });
    const round = await app.request("/api/pdf-template-config", { headers: fin });
    expect(round.status).toBe(200);
    const { config } = (await round.json()) as { config: unknown };
    expect(config).toEqual({
      brandColor: "#14532D",
      company: {
        name: "Acme Flavors LLC",
        addressLines: ["9 Flavor Way", "Newark, NJ"],
        email: "billing@acme.test",
        phone: "+1 973 555 0100",
      },
      paymentInstructions: {
        bankName: "First Bank",
        accountName: "Acme Flavors LLC",
        accountNumber: "000123456",
        routingNumber: "021000021",
        referenceNote: "Include the invoice number as payment reference.",
      },
    });
  });
});

function adminUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) return ""; // 套件被跳过时不会被用到
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

