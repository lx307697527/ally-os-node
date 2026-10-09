import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";

// 集成测试：需要真实 PostgreSQL（发号事务、行合计生成列、冲抵边界行锁、审计）。
// 未设 DATABASE_URL 时跳过。独立临时库（样板：routes/invoices.test.ts）。
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

function adminUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) return ""; // 套件被跳过时不会被用到
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

describe.skipIf(!databaseUrl)("credit note endpoints (#192 red-verb slice, integration)", () => {
  const dbName = `credit_notes_test_${String(Date.now())}_${String(process.pid)}`;
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
      head: () => Promise.reject(new Error("storage not used in this suite")),
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
      sql`truncate table ${schema.creditNoteLines}, ${schema.creditNotes}, ${schema.invoiceLines}, ${schema.invoices}, ${schema.payments} cascade`,
    );
    await db.execute(sql`truncate table ${schema.auditEvents}`);
    await db
      .update(schema.numberingRules)
      .set({ active: true })
      .where(eq(schema.numberingRules.subject, "credit_note"));
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
    status: "draft" | "issued" | "void";
    totalCents: number;
    creditedCents: number;
    paidCents: number;
    paymentStatus: "unpaid" | "partial" | "paid";
  }

  async function createInvoice(lines: DraftLine[]): Promise<string> {
    const res = await app.request("/api/invoices", {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({ invoiceType: "balance", lines }),
    });
    const json = (await res.json()) as { id?: string };
    if (res.status !== 201 || json.id === undefined) {
      throw new Error(`createInvoice failed: ${String(res.status)}`);
    }
    return json.id;
  }

  /** 夹具：建票 → 确认发出（无账期），返回发票 id */
  async function seedIssuedInvoice(lines: DraftLine[] = [lineBody("Balance for batch 1", 1, 150000)]): Promise<string> {
    const id = await createInvoice(lines);
    const res = await app.request(`/api/invoices/${id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({}),
    });
    if (res.status !== 200) {
      throw new Error(`seedIssuedInvoice confirm failed: ${String(res.status)}`);
    }
    return id;
  }

  async function getInvoice(id: string): Promise<InvoiceJson> {
    const res = await app.request(`/api/invoices/${id}`, { headers: fin });
    return (await res.json()) as InvoiceJson;
  }

  async function createCreditNote(
    invoiceId: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = fin,
  ): Promise<{ status: number; json: { id?: string; number?: string; error?: string } }> {
    const res = await app.request(`/api/invoices/${invoiceId}/credit-notes`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as { id?: string; error?: string; number?: string } };
  }

  const creditBody = (lines: DraftLine[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    reason: "Wrong unit price on line 1",
    lines,
    ...extra,
  });

  async function auditCount(action: string): Promise<number> {
    const rows = await db
      .select({ n: sql<string>`count(*)` })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, action));
    return Number(rows[0]?.n ?? 0);
  }

  it("creates a draft credit note on an issued invoice: numbering-issued number, generated totals, currency copied", async () => {
    const invoiceId = await seedIssuedInvoice();
    const created = await createCreditNote(
      invoiceId,
      creditBody([lineBody("Line 1 price correction", 1, 50000)]),
    );
    expect(created.status).toBe(201);
    expect(created.json.number).toMatch(/^CN-\d{4}$/);
    expect(created.json.id).toBeDefined();
    const detail = await app.request(`/api/credit-notes/${created.json.id}`, { headers: fin });
    expect(detail.status).toBe(200);
    const note = (await detail.json()) as {
      number: string;
      invoiceId: string;
      invoiceNumber: string;
      status: string;
      reason: string;
      currency: string;
      totalCents: number;
      lines: { lineNumber: number; lineTotalCents: number }[];
    };
    expect(note.number).toMatch(/^CN-\d{4}$/);
    expect(note.invoiceId).toBe(invoiceId);
    expect(note.invoiceNumber).toMatch(/^INV-\d{4}$/);
    expect(note.status).toBe("draft");
    expect(note.reason).toBe("Wrong unit price on line 1");
    expect(note.currency).toBe("USD");
    expect(note.totalCents).toBe(50000);
    expect(note.lines).toEqual([expect.objectContaining({ lineNumber: 1, lineTotalCents: 50000 })]);
  });

  it("rejects credit notes on draft invoices (409 not_issued), voided invoices (409 invoice_voided) and unknown ids (404)", async () => {
    const draftId = await createInvoice([lineBody("Balance", 1, 100000)]);
    const onDraft = await createCreditNote(draftId, creditBody([lineBody("Correction", 1, 1000)]));
    expect(onDraft.status).toBe(409);
    expect(onDraft.json.error).toBe("not_issued");

    const voidRes = await app.request(`/api/invoices/${draftId}/void`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({ reason: "issued by mistake" }),
    });
    expect(voidRes.status).toBe(200);
    const onVoid = await createCreditNote(draftId, creditBody([lineBody("Correction", 1, 1000)]));
    expect(onVoid.status).toBe(409);
    expect(onVoid.json.error).toBe("invoice_voided");

    const missing = await createCreditNote(randomUUID(), creditBody([lineBody("Correction", 1, 1000)]));
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe("not_found");
  });

  it("enforces the credit bound structurally: exact total passes, one cent more fails with 409", async () => {
    const invoiceId = await seedIssuedInvoice([lineBody("Balance", 1, 150000)]);
    const first = await createCreditNote(invoiceId, creditBody([lineBody("Partial correction", 1, 100000)]));
    expect(first.status).toBe(201);
    const confirmRes = await app.request(`/api/credit-notes/${first.json.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({}),
    });
    expect(confirmRes.status).toBe(200);

    const overByOne = await createCreditNote(invoiceId, creditBody([lineBody("Over-credit", 1, 50001)]));
    expect(overByOne.status).toBe(409);
    expect(overByOne.json.error).toBe("credit_exceeds_invoice");

    // 第二张草稿先占边界但未经财务确认——有效贷项仍只有第一张的 100000
    const exact = await createCreditNote(invoiceId, creditBody([lineBody("Remainder", 1, 50000)]));
    expect(exact.status).toBe(201);
    const draftState = await getInvoice(invoiceId);
    expect(draftState.creditedCents).toBe(100000);
    expect(draftState.paymentStatus).toBe("unpaid");
    await app.request(`/api/credit-notes/${exact.json.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({}),
    });
    const invoice = await getInvoice(invoiceId);
    expect(invoice.creditedCents).toBe(150000);
    expect(invoice.paymentStatus).toBe("paid");
  });

  it("voided credit notes leave the bound and the derived due (a void is a correction, not a deletion)", async () => {
    const invoiceId = await seedIssuedInvoice([lineBody("Balance", 1, 150000)]);
    const wrong = await createCreditNote(invoiceId, creditBody([lineBody("Wrong credit", 1, 100000)]));
    expect(wrong.status).toBe(201);
    const voided = await app.request(`/api/credit-notes/${wrong.json.id}/void`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({ reason: "wrong line" }),
    });
    expect(voided.status).toBe(200);
    const full = await createCreditNote(invoiceId, creditBody([lineBody("Full correction", 1, 150000)]));
    expect(full.status).toBe(201);
    const invoice = await getInvoice(invoiceId);
    // 未确认的贷项不计入有效应付：creditedCents 只数 issued（且未 void）的单
    expect(invoice.creditedCents).toBe(0);
    expect(invoice.paymentStatus).toBe("unpaid");
    const confirmRes = await app.request(`/api/credit-notes/${full.json.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({}),
    });
    expect(confirmRes.status).toBe(200);
    const after = await getInvoice(invoiceId);
    expect(after.creditedCents).toBe(150000);
    expect(after.paymentStatus).toBe("paid");
  });

  it("confirms a credit note: audit with credited total, idempotent repeat, voided note not confirmable", async () => {
    const invoiceId = await seedIssuedInvoice([lineBody("Balance", 1, 150000)]);
    const created = await createCreditNote(invoiceId, creditBody([lineBody("Correction", 1, 50000)]));
    const confirmRes = await app.request(`/api/credit-notes/${created.json.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({}),
    });
    expect(confirmRes.status).toBe(200);
    expect(((await confirmRes.json()) as { status: string }).status).toBe("issued");
    expect(await auditCount("credit_note.confirmed")).toBe(1);

    const repeat = await app.request(`/api/credit-notes/${created.json.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({}),
    });
    expect(((await repeat.json()) as { status: string }).status).toBe("already");
    expect(await auditCount("credit_note.confirmed")).toBe(1);

    const wrong = await createCreditNote(invoiceId, creditBody([lineBody("Wrong", 1, 1000)]));
    await app.request(`/api/credit-notes/${wrong.json.id}/void`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({ reason: "wrong" }),
    });
    const onVoid = await app.request(`/api/credit-notes/${wrong.json.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({}),
    });
    expect(onVoid.status).toBe(409);
    expect(((await onVoid.json()) as { error: string }).error).toBe("credit_note_voided");
  });

  it("voids a draft with idempotent repeat; issued credit notes are terminal (409 not_voidable)", async () => {
    const invoiceId = await seedIssuedInvoice([lineBody("Balance", 1, 150000)]);
    const created = await createCreditNote(invoiceId, creditBody([lineBody("Correction", 1, 50000)]));
    const voidRes = await app.request(`/api/credit-notes/${created.json.id}/void`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({ reason: "wrong line" }),
    });
    expect(voidRes.status).toBe(200);
    expect(((await voidRes.json()) as { status: string }).status).toBe("voided");
    expect(await auditCount("credit_note.voided")).toBe(1);
    const repeat = await app.request(`/api/credit-notes/${created.json.id}/void`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({ reason: "wrong line" }),
    });
    expect(((await repeat.json()) as { status: string }).status).toBe("already");
    expect(await auditCount("credit_note.voided")).toBe(1);

    const issued = await createCreditNote(invoiceId, creditBody([lineBody("Keep", 1, 1000)]));
    await app.request(`/api/credit-notes/${issued.json.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({}),
    });
    const onIssued = await app.request(`/api/credit-notes/${issued.json.id}/void`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({ reason: "changed my mind" }),
    });
    expect(onIssued.status).toBe(409);
    expect(((await onIssued.json()) as { error: string }).error).toBe("not_voidable");
  });

  it("rejects an empty note, bad quantities, line overflow, and a missing reason with 400", async () => {
    const invoiceId = await seedIssuedInvoice();
    const empty = await createCreditNote(invoiceId, creditBody([]));
    expect(empty.status).toBe(400);
    const noReason = await createCreditNote(invoiceId, {
      lines: [lineBody("Correction", 1, 1000)],
    });
    expect(noReason.status).toBe(400);
    const badQuantity = await createCreditNote(
      invoiceId,
      creditBody([lineBody("Correction", 1.0001, 1000)]),
    );
    expect(badQuantity.status).toBe(400);
    const overflow = await createCreditNote(
      invoiceId,
      creditBody([lineBody("Correction", 2, 2_000_000_000)]),
    );
    expect(overflow.status).toBe(400);
  });

  it("fails closed when no credit-note numbering rule is active (409 numbering_not_configured)", async () => {
    const invoiceId = await seedIssuedInvoice();
    await db
      .update(schema.numberingRules)
      .set({ active: false })
      .where(eq(schema.numberingRules.subject, "credit_note"));
    const created = await createCreditNote(invoiceId, creditBody([lineBody("Correction", 1, 1000)]));
    expect(created.status).toBe(409);
    expect(created.json.error).toBe("numbering_not_configured");
  });

  it("lists a ledger per invoice with the active credited total (void rows kept for the record)", async () => {
    const invoiceId = await seedIssuedInvoice([lineBody("Balance", 1, 150000)]);
    const a = await createCreditNote(invoiceId, creditBody([lineBody("A", 1, 40000)]));
    await app.request(`/api/credit-notes/${a.json.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({}),
    });
    const b = await createCreditNote(invoiceId, creditBody([lineBody("B", 1, 2000)]));
    await app.request(`/api/credit-notes/${b.json.id}/void`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({ reason: "wrong" }),
    });
    const list = await app.request(`/api/invoices/${invoiceId}/credit-notes`, { headers: fin });
    expect(list.status).toBe(200);
    const ledger = (await list.json()) as {
      creditedCents: number;
      creditNotes: { id: string; number: string; status: string; totalCents: number; voidedAt: string | null }[];
    };
    expect(ledger.creditNotes).toHaveLength(2);
    expect(ledger.creditNotes.map((note) => note.id).sort()).toEqual([a.json.id, b.json.id].sort());
    const voidedRow = ledger.creditNotes.find((note) => note.id === b.json.id);
    expect(voidedRow?.status).toBe("void");
    expect(voidedRow?.voidedAt).not.toBeNull();
    expect(ledger.creditedCents).toBe(40000);
    const missing = await app.request(`/api/invoices/${randomUUID()}/credit-notes`, { headers: fin });
    expect(missing.status).toBe(404);
  });

  it("carries creditedCents into the payment derivation (recording up to the effective due settles the invoice)", async () => {
    const invoiceId = await seedIssuedInvoice([lineBody("Balance", 1, 150000)]);
    const credit = await createCreditNote(invoiceId, creditBody([lineBody("Correction", 1, 50000)]));
    await app.request(`/api/credit-notes/${credit.json.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({}),
    });
    const record = await app.request(`/api/invoices/${invoiceId}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({ amountCents: 100000, method: "wire_ach", receivedAt: new Date().toISOString() }),
    });
    expect(record.status).toBe(201);
    const recorded = (await record.json()) as { creditedCents: number; paidCents: number; paymentStatus: string };
    expect(recorded.creditedCents).toBe(50000);
    expect(recorded.paidCents).toBe(100000);
    expect(recorded.paymentStatus).toBe("paid");
    const invoice = await getInvoice(invoiceId);
    expect(invoice.creditedCents).toBe(50000);
    expect(invoice.paymentStatus).toBe("paid");
  });

  it("gates every verb behind invoices.manage (sales 403, owner passes; unauthenticated 404s)", async () => {
    const invoiceId = await seedIssuedInvoice();
    const asSales = await createCreditNote(invoiceId, creditBody([lineBody("Correction", 1, 1000)]), sal);
    expect(asSales.status).toBe(403);
    const asOwner = await createCreditNote(invoiceId, creditBody([lineBody("Correction", 1, 1000)]), own);
    expect(asOwner.status).toBe(201);
    const noteId = asOwner.json.id ?? "";
    for (const [method, path] of [
      ["GET", `/api/credit-notes/${noteId}`],
      ["POST", `/api/credit-notes/${noteId}/confirm`],
      ["POST", `/api/credit-notes/${noteId}/void`],
      ["GET", `/api/invoices/${invoiceId}/credit-notes`],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { "content-type": "application/json", "x-test-user": "sal" },
        ...(method === "POST" ? { body: JSON.stringify({}) } : {}),
      });
      expect(res.status).toBe(403);
    }
    const anon = await app.request(`/api/credit-notes/${noteId}`, { headers: {} });
    expect([401, 403]).toContain(anon.status);
  });

  it("404s unknown credit note ids on every read and verb", async () => {
    const missing = randomUUID();
    for (const [method, path] of [
      ["GET", `/api/credit-notes/${missing}`],
      ["POST", `/api/credit-notes/${missing}/confirm`],
      ["POST", `/api/credit-notes/${missing}/void`],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { "content-type": "application/json", ...fin },
        ...(method === "POST" ? { body: JSON.stringify({}) } : {}),
      });
      expect(res.status).toBe(404);
    }
  });
});
