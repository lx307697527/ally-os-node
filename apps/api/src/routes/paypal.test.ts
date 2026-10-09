import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import {
  createPayPalGateway,
  createPayPalWebhookVerifier,
  type Fetcher,
  type PayPalChannel,
} from "../billing/paypal.ts";
import type { SessionData } from "../auth/session.ts";

/**
 * PayPal 渠道端到端集成测试（#193）：checkout 订单创建（财务面）+ 活体验签与
 * 幂等记账（provider 面）+ APPROVED 驱动的服务端 capture。需要真实 PostgreSQL
 * （发票状态门、收款唯一索引、审计、同事务原子性）；未设 DATABASE_URL 时跳过。
 *
 * PayPal 的验签是活体 API 调用（billing/paypal.ts 文件头），webhook 的请求按
 * PayPal 真实投递形状构造（五根 transmission 头 + 事件体），验签经注入的假
 * PayPal API 走完整 token → verify 两跳——与 billing/paypal.test.ts 的纯函数
 * 面互补，这里证明的是「验签 → 归一 → 记账 → 审计」整条链（含挂在会话中间件
 * 之前的路由顺序）。
 */
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

const WEB_APP_URL = "https://app.example.com";

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

// ── 假 PayPal API：订单 / capture / 验签三轨全可编程 ─────────────────────────

interface ApiState {
  orders: { body: Record<string, unknown> }[];
  captures: string[];
  verifyStatus: "SUCCESS" | "FAILURE";
  captureBehavior: "ok" | "already" | "fail";
}

function fakeApi(state: ApiState): Fetcher {
  return vi.fn(((url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const json = (body: unknown, status: number) =>
      new Response(body === undefined ? null : JSON.stringify(body), { status });
    if (href.includes("/v1/oauth2/token")) {
      return json({ access_token: "token-1" }, 200);
    }
    if (href.includes("/v1/notifications/verify-webhook-signature")) {
      return json({ verification_status: state.verifyStatus }, 200);
    }
    if (/\/v2\/checkout\/orders\/[^/]+\/capture$/.test(href)) {
      if (state.captureBehavior === "already") {
        return json(
          { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] },
          422,
        );
      }
      if (state.captureBehavior === "fail") {
        return json({ message: "boom" }, 500);
      }
      state.captures.push(href);
      return json({ id: "ORDER-1", status: "COMPLETED" }, 201);
    }
    if (href.includes("/v2/checkout/orders")) {
      state.orders.push({ body: JSON.parse((init?.body) as string) as Record<string, unknown> });
      return json(
        {
          id: `ORDER-${String(state.orders.length)}`,
          links: [{ rel: "payer-action", href: "https://www.paypal.com/checkoutnow?token=ORDER-1" }],
        },
        201,
      );
    }
    return new Response(null, { status: 404 });
  }) as unknown as Fetcher);
}

function channel(fetcher: Fetcher): PayPalChannel {
  return {
    // 真网关/验签器包着假 fetcher：订单/capture 的请求形状与 token/verify 两跳
    // 的 fail-closed 分支都按生产行为走
    gateway: createPayPalGateway({ clientId: "cid", clientSecret: "secret", fetcher }),
    verifier: createPayPalWebhookVerifier({ clientId: "cid", clientSecret: "secret", webhookId: "WH-ID", fetcher }),
    webAppUrl: WEB_APP_URL,
  };
}

function apiState(): ApiState {
  return { orders: [], captures: [], verifyStatus: "SUCCESS", captureBehavior: "ok" };
}

// ── PayPal 线格式的投递构造 ──────────────────────────────────────────────────

const TRANSMISSION_HEADERS = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/CERT-360",
  "paypal-transmission-id": "69cd13",
  "paypal-transmission-sig": "SignatureExample==",
  "paypal-transmission-time": new Date().toISOString(),
} as const;

function captureCompletedEvent(input: {
  invoiceId?: string;
  /** PayPal 报的实收额（gross）：有拆分声明时 = principal + surcharge */
  amount: string;
  captureId?: string;
  /** surcharged 订单的声明；缺省 = 裸 custom_id；null = 无 custom_id */
  carrier?: string | null;
}): string {
  return JSON.stringify({
    id: `WH-${randomUUID()}`,
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: {
      id: input.captureId ?? `CAP-${randomUUID()}`,
      status: "COMPLETED",
      amount: { value: input.amount, currency_code: "USD" },
      ...(input.carrier === null ? {} : { custom_id: input.carrier ?? input.invoiceId }),
      create_time: new Date(Date.now() - 60_000).toISOString(),
    },
  });
}

function orderApprovedEvent(input: { orderId: string; invoiceId?: string | null }): string {
  return JSON.stringify({
    id: `WH-${randomUUID()}`,
    event_type: "CHECKOUT.ORDER.APPROVED",
    resource: {
      id: input.orderId,
      status: "APPROVED",
      ...(input.invoiceId === null
        ? {}
        : { purchase_units: [{ custom_id: input.invoiceId ?? "00000000-0000-4000-8000-000000000000" }] }),
    },
  });
}

describe.skipIf(!databaseUrl)("paypal checkout & webhook (#193, integration)", () => {
  const dbName = `paypal_test_${String(Date.now())}_${String(process.pid)}`;
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

  const state = apiState();
  // 实时「催」的记录器（#193 剩余③）：催名单 = 真正拿到新通知行的人
  const notifyCalls: string[][] = [];
  const notifyUsers = (userIds: string[]): Promise<void> => {
    notifyCalls.push(userIds);
    return Promise.resolve();
  };
  const app = createApp({
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
    notifyUsers,
    stripe: undefined,
    sendPasswordSetupEmail: async () => {},
    paypal: channel(fakeApi(state)),
  });

  // 同一夹具的「渠道未配置」变体：webhook 与 checkout 都必须 fail closed
  const appWithoutPaypal = createApp({
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
    notifyUsers,
    stripe: undefined,
    sendPasswordSetupEmail: async () => {},
    paypal: undefined,
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
    await db.insert(schema.numberingRules).values([
      { subject: "invoice", label: "Invoice", prefix: "INV-", dateFormat: null, padding: 4, startNumber: 3000 },
      { subject: "credit_note", label: "Credit note", prefix: "CN-", dateFormat: null, padding: 4, startNumber: 7000 },
    ]);
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table ${schema.creditNoteLines}, ${schema.creditNotes}, ${schema.payments}, ${schema.invoiceLines}, ${schema.invoices} cascade`);
    await db.execute(sql`truncate table ${schema.notifications} cascade`);
    await db.execute(sql`truncate table ${schema.auditEvents}`);
    state.orders = [];
    state.captures = [];
    state.verifyStatus = "SUCCESS";
    state.captureBehavior = "ok";
    notifyCalls.length = 0;
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
    paidCents: number;
    paymentStatus: "unpaid" | "partial" | "paid";
  }

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
    const confirmed = await app.request(`/api/invoices/${id}/confirm`, { method: "POST", headers: fin });
    if (confirmed.status !== 200) {
      throw new Error(`seedIssuedInvoice confirm failed: ${String(confirmed.status)}`);
    }
    const res = await app.request(`/api/invoices/${id}`, { headers: fin });
    return (await res.json()) as InvoiceJson;
  }

  async function seedDraftInvoice(): Promise<InvoiceJson> {
    const created = await app.request("/api/invoices", {
      method: "POST",
      headers: { "content-type": "application/json", ...fin },
      body: JSON.stringify({
        invoiceType: "sampling_fee",
        lines: [{ description: "Draft", quantity: 1, unitPriceCents: 20000 }],
      }),
    });
    return (await created.json()) as InvoiceJson;
  }

  async function auditCount(action: string): Promise<number> {
    const rows = await db
      .select({ n: sql<string>`count(*)` })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, action));
    return Number(rows[0]?.n ?? 0);
  }

  async function paymentRowCount(): Promise<number> {
    const rows = await db.select({ n: sql<string>`count(*)` }).from(schema.payments);
    return Number(rows[0]?.n ?? 0);
  }

  async function notificationCount(): Promise<number> {
    const rows = await db.select({ n: sql<string>`count(*)` }).from(schema.notifications);
    return Number(rows[0]?.n ?? 0);
  }

  async function deliverWebhook(
    body: string,
    headers: Record<string, string> = { ...TRANSMISSION_HEADERS },
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await app.request("/api/webhooks/paypal", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  describe("checkout order (finance face)", () => {
    it("creates an order for an issued invoice with the R-12-2/3 surcharge disclosed", async () => {
      const invoice = await seedIssuedInvoice(); // principal 150000，种子费率 3.9%
      const res = await app.request(`/api/invoices/${invoice.id}/paypal-checkout`, {
        method: "POST",
        headers: fin,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        invoiceId: string;
        number: string;
        orderId: string;
        url: string;
        amountCents: number;
        principalCents: number;
        surchargeCents: number;
        currency: string;
      };
      expect(body.amountCents).toBe(155850); // 实扣 gross
      expect(body.principalCents).toBe(150000);
      expect(body.surchargeCents).toBe(5850);
      expect(body.currency).toBe("USD");
      expect(body.url).toContain("paypal.com");

      // 订单形状：实扣额进 amount、声明坐 custom_id、回跳不带金额入口
      expect(state.orders).toHaveLength(1);
      const order = state.orders[0]?.body as {
        purchase_units: { amount: { value: string; currency_code: string }; custom_id: string }[];
        application_context: { return_url: string; cancel_url: string };
      };
      expect(order.purchase_units[0]?.amount).toEqual({ currency_code: "USD", value: "1558.50" });
      expect(order.purchase_units[0]?.custom_id).toBe(`${invoice.id};p=150000;s=5850`);
      expect(order.application_context.return_url).toBe(
        `${WEB_APP_URL}/portal/invoices/${invoice.id}?paypal=return`,
      );
      expect(order.application_context.cancel_url).toBe(
        `${WEB_APP_URL}/portal/invoices/${invoice.id}?paypal=cancel`,
      );

      const audits = await db
        .select({ detail: schema.auditEvents.detail })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.action, "invoice.payment_link_created"));
      expect(audits).toHaveLength(1);
      expect(audits[0]?.detail).toMatchObject({
        provider: "paypal",
        amountCents: 155850,
        principalCents: 150000,
        surchargeCents: 5850,
      });
    });

    it("treats a 0% rate as the kill switch: a bare custom_id order", async () => {
      const ruleKey = "payments.paypal_surcharge_pct";
      try {
        await db.update(schema.registryRules).set({ value: 0 }).where(eq(schema.registryRules.key, ruleKey));
        const invoice = await seedIssuedInvoice();
        const res = await app.request(`/api/invoices/${invoice.id}/paypal-checkout`, {
          method: "POST",
          headers: fin,
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { amountCents: number; surchargeCents: number };
        expect(body.amountCents).toBe(150000); // gross = principal
        expect(body.surchargeCents).toBe(0);
        const order = state.orders[0]?.body as { purchase_units: { custom_id: string }[] };
        expect(order.purchase_units[0]?.custom_id).toBe(invoice.id); // 裸形式：无费订单
      } finally {
        await db.update(schema.registryRules).set({ value: 3.9 }).where(eq(schema.registryRules.key, ruleKey));
      }
    });

    it("refuses to create orders while the surcharge rule is unusable (fail closed)", async () => {
      const ruleKey = "payments.paypal_surcharge_pct";
      try {
        for (const broken of [null, 6]) {
          await db.update(schema.registryRules).set({ value: broken }).where(eq(schema.registryRules.key, ruleKey));
          const invoice = await seedIssuedInvoice();
          const res = await app.request(`/api/invoices/${invoice.id}/paypal-checkout`, {
            method: "POST",
            headers: fin,
          });
          expect(res.status).toBe(409);
          expect(((await res.json()) as { error: string }).error).toBe("surcharge_rule_unusable");
        }
        expect(state.orders).toHaveLength(0); // 一个订单都没建
      } finally {
        await db.update(schema.registryRules).set({ value: 3.9 }).where(eq(schema.registryRules.key, ruleKey));
      }
    });

    it("refuses drafts, voided and zero-total invoices; enforces invoices.manage", async () => {
      const draft = await seedDraftInvoice();
      const onDraft = await app.request(`/api/invoices/${draft.id}/paypal-checkout`, { method: "POST", headers: fin });
      expect(onDraft.status).toBe(409);
      expect(((await onDraft.json()) as { error: string }).error).toBe("not_issued");

      await app.request(`/api/invoices/${draft.id}/void`, { method: "POST", headers: fin });
      const onVoid = await app.request(`/api/invoices/${draft.id}/paypal-checkout`, { method: "POST", headers: fin });
      expect(onVoid.status).toBe(409);
      expect(((await onVoid.json()) as { error: string }).error).toBe("invoice_voided");

      const zero = await seedIssuedInvoice([
        { description: "Courtesy", quantity: 1, unitPriceCents: 0 },
      ]);
      const onZero = await app.request(`/api/invoices/${zero.id}/paypal-checkout`, { method: "POST", headers: fin });
      expect(onZero.status).toBe(409);
      expect(((await onZero.json()) as { error: string }).error).toBe("nothing_to_collect");
      const invoice = await seedIssuedInvoice();
      expect(
        (await app.request(`/api/invoices/${invoice.id}/paypal-checkout`, { method: "POST", headers: sal })).status,
      ).toBe(403);
      expect(
        (await app.request(`/api/invoices/${invoice.id}/paypal-checkout`, { method: "POST", headers: own })).status,
      ).toBe(201);
      expect(
        (await app.request(`/api/invoices/${randomUUID()}/paypal-checkout`, { method: "POST", headers: fin })).status,
      ).toBe(404);
    });

    it("collects the effective due: confirmed credits shrink the order principal, full credit refuses", async () => {
      const invoice = await seedIssuedInvoice(); // 面额 150000，种子费率 3.9%
      const created = await app.request(`/api/invoices/${invoice.id}/credit-notes`, {
        method: "POST",
        headers: { "content-type": "application/json", ...fin },
        body: JSON.stringify({
          reason: "Line 1 overbilled",
          lines: [{ description: "Price correction", quantity: 1, unitPriceCents: 50000 }],
        }),
      });
      expect(created.status).toBe(201);
      const noteId = ((await created.json()) as { id: string }).id;
      const confirmed = await app.request(`/api/credit-notes/${noteId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json", ...fin },
        body: JSON.stringify({}),
      });
      expect(confirmed.status).toBe(200);

      // 结算额 = 有效应付 100000：gross = 100000 + 3.9% = 103900
      const res = await app.request(`/api/invoices/${invoice.id}/paypal-checkout`, {
        method: "POST",
        headers: fin,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { amountCents: number; principalCents: number; surchargeCents: number };
      expect(body.principalCents).toBe(100000);
      expect(body.surchargeCents).toBe(3900);
      expect(body.amountCents).toBe(103900);

      // 余款 100000 的贷项确认后，有效应付归零
      const second = await app.request(`/api/invoices/${invoice.id}/credit-notes`, {
        method: "POST",
        headers: { "content-type": "application/json", ...fin },
        body: JSON.stringify({
          reason: "Remainder",
          lines: [{ description: "Remainder", quantity: 1, unitPriceCents: 100000 }],
        }),
      });
      expect(second.status).toBe(201);
      const secondId = ((await second.json()) as { id: string }).id;
      const secondConfirmed = await app.request(`/api/credit-notes/${secondId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json", ...fin },
        body: JSON.stringify({}),
      });
      expect(secondConfirmed.status).toBe(200);
      const ledger = await app.request(`/api/invoices/${invoice.id}/credit-notes`, { headers: fin });
      expect(((await ledger.json()) as { creditedCents: number }).creditedCents).toBe(150000);
      const empty = await app.request(`/api/invoices/${invoice.id}/paypal-checkout`, {
        method: "POST",
        headers: fin,
      });
      expect(empty.status).toBe(409);
      expect(((await empty.json()) as { error: string }).error).toBe("nothing_to_collect");
    });


    it("answers 500 misconfigured when the channel is disabled (fail closed)", async () => {
      const invoice = await seedIssuedInvoice();
      const res = await appWithoutPaypal.request(`/api/invoices/${invoice.id}/paypal-checkout`, {
        method: "POST",
        headers: fin,
      });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toBe("misconfigured");
    });
  });

  describe("webhook (provider face)", () => {
    it("walks the full loop: verified capture → payment row → audit → paid invoice", async () => {
      const invoice = await seedIssuedInvoice();
      const res = await deliverWebhook(captureCompletedEvent({ invoiceId: invoice.id, amount: "1500.00" }));
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ received: true, invoiceNumber: invoice.number, paymentStatus: "paid" });

      const rows = await db.select().from(schema.payments);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row === undefined) throw new Error("payment row missing");
      expect(row.method).toBe("paypal");
      expect(row.amountCents).toBe(150000);
      expect(row.currency).toBe("USD");
      expect(row.sourceType).toBe("paypal");
      expect(row.sourceKey).toMatch(/^CAP-/);
      expect(row.recordedById).toBeNull(); // webhook 记账无用户上下文
      expect(row.voidedAt).toBeNull();

      const detail = await app.request(`/api/invoices/${invoice.id}`, { headers: fin });
      expect(((await detail.json()) as InvoiceJson).paymentStatus).toBe("paid");

      expect(await auditCount("payment.recorded")).toBe(1);
    });

    it("books the surcharged split: principal on the ledger, fee beside it", async () => {
      const invoice = await seedIssuedInvoice();
      const res = await deliverWebhook(
        captureCompletedEvent({
          invoiceId: invoice.id,
          amount: "1558.50",
          carrier: `${invoice.id};p=150000;s=5850`,
        }),
      );
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ paymentStatus: "paid" });
      const row = (await db.select().from(schema.payments))[0];
      expect(row?.amountCents).toBe(150000); // 台账只装结清额
      expect(row?.surchargeCents).toBe(5850);
      // 审计同事务：金额与拆分快照随行
      const audit = await db
        .select({ detail: schema.auditEvents.detail })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.action, "payment.recorded"));
      expect(audit[0]?.detail).toMatchObject({ amountCents: 150000, surchargeCents: 5850, method: "paypal" });
    });

    it("answers a replay with 200 and does not book twice", async () => {
      const invoice = await seedIssuedInvoice();
      const captureId = `CAP-${randomUUID()}`;
      const first = await deliverWebhook(
        captureCompletedEvent({ invoiceId: invoice.id, amount: "1500.00", captureId }),
      );
      expect(first.status).toBe(200);
      const second = await deliverWebhook(
        captureCompletedEvent({ invoiceId: invoice.id, amount: "1500.00", captureId }),
      );
      expect(second.status).toBe(200);
      expect(second.json).toMatchObject({ replay: true });
      expect(await paymentRowCount()).toBe(1);
      expect(await auditCount("payment.recorded")).toBe(1);
    });

    it("holds money on a draft invoice across confirmation via 502 + redelivery", async () => {
      const draft = await seedDraftInvoice();
      const body = captureCompletedEvent({ invoiceId: draft.id, amount: "200.00" });
      const refused = await deliverWebhook(body);
      expect(refused.status).toBe(502);
      expect(await paymentRowCount()).toBe(0);

      // 财务确认（R-12-6 人的闸门）→ PayPal 重投 → 记账成功
      await app.request(`/api/invoices/${draft.id}/confirm`, { method: "POST", headers: fin });
      const after = await deliverWebhook(body);
      expect(after.status).toBe(200);
      expect(after.json).toMatchObject({ paymentStatus: "paid" });
      expect(await paymentRowCount()).toBe(1);
    });

    it("refuses money on a voided or unknown invoice with 502", async () => {
      const draft = await seedDraftInvoice();
      await app.request(`/api/invoices/${draft.id}/void`, { method: "POST", headers: fin });
      const onVoid = await deliverWebhook(captureCompletedEvent({ invoiceId: draft.id, amount: "200.00" }));
      expect(onVoid.status).toBe(502);
      expect((onVoid.json as { error: string }).error).toBe("invoice_voided");

      const unknown = await deliverWebhook(
        captureCompletedEvent({ invoiceId: randomUUID(), amount: "200.00" }),
      );
      expect(unknown.status).toBe(502);
      expect((unknown.json as { error: string }).error).toBe("invoice_not_found");
      expect(await paymentRowCount()).toBe(0);
    });

    it("acks a capture without our anchor and books nothing (#181 will claim it)", async () => {
      const res = await deliverWebhook(captureCompletedEvent({ amount: "10.00", carrier: null }));
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ received: true });
      expect(await paymentRowCount()).toBe(0);
    });

    it("refuses a capture whose declaration does not reconcile with 502", async () => {
      const invoice = await seedIssuedInvoice();
      // 声明的拆分与实收对不上：两个数字必有一个是错的，什么都不入账
      const res = await deliverWebhook(
        captureCompletedEvent({
          invoiceId: invoice.id,
          amount: "1600.00",
          carrier: `${invoice.id};p=150000;s=5850`,
        }),
      );
      expect(res.status).toBe(502);
      expect((res.json as { error: string }).error).toBe("unparsable_event");
      expect(await paymentRowCount()).toBe(0);

      // 半申报同罪
      const half = await deliverWebhook(
        captureCompletedEvent({ invoiceId: invoice.id, amount: "10.00", carrier: `${invoice.id};p=7` }),
      );
      expect(half.status).toBe(502);
      // 非 UUID 的 invoice id（有人动过载体）响而可见
      const badUuid = await deliverWebhook(
        captureCompletedEvent({ amount: "10.00", carrier: "not-a-uuid" }),
      );
      expect(badUuid.status).toBe(502);
    });

    it("ignores refunds and declines with a 200 ack and no side effects", async () => {
      const invoice = await seedIssuedInvoice();
      for (const eventType of ["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.DECLINED"]) {
        const body = JSON.stringify({
          id: `WH-${randomUUID()}`,
          event_type: eventType,
          resource: { id: `CAP-${randomUUID()}`, amount: { value: "10.00" }, custom_id: invoice.id },
        });
        const res = await deliverWebhook(body);
        expect(res.status).toBe(200);
      }
      expect(await paymentRowCount()).toBe(0);
    });

    it("refuses a delivery with a missing transmission header or failed verification (401, zero side effects)", async () => {
      const invoice = await seedIssuedInvoice();
      const body = captureCompletedEvent({ invoiceId: invoice.id, amount: "1500.00" });

      for (const header of Object.keys(TRANSMISSION_HEADERS)) {
        const partial = Object.fromEntries(
          Object.entries(TRANSMISSION_HEADERS).filter(([name]) => name !== header),
        );
        const res = await deliverWebhook(body, partial);
        expect(res.status).toBe(401);
      }

      state.verifyStatus = "FAILURE";
      const failed = await deliverWebhook(body);
      expect(failed.status).toBe(401);
      expect(await paymentRowCount()).toBe(0);
      expect(await auditCount("payment.recorded")).toBe(0);
    });

    it("refuses a malformed body with 400 before any side effect", async () => {
      const res = await app.request("/api/webhooks/paypal", {
        method: "POST",
        headers: { "content-type": "application/json", ...TRANSMISSION_HEADERS },
        body: "{not json",
      });
      expect(res.status).toBe(400);
      expect(await paymentRowCount()).toBe(0);
    });

    it("answers non-POST with 405", async () => {
      expect((await app.request("/api/webhooks/paypal", { headers: fin })).status).toBe(405);
    });

    it("answers 500 misconfigured when the channel is disabled (fail closed)", async () => {
      const res = await appWithoutPaypal.request("/api/webhooks/paypal", {
        method: "POST",
        headers: { "content-type": "application/json", ...TRANSMISSION_HEADERS },
        body: captureCompletedEvent({ amount: "10.00", carrier: null }),
      });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toBe("misconfigured");
    });
  });

  describe("payment alerts (#193 剩余③: unbookable money)", () => {
    it("tells finance about money stuck on a draft invoice; the redelivery adds no rows", async () => {
      const draft = await seedDraftInvoice();
      const body = captureCompletedEvent({ invoiceId: draft.id, amount: "200.00" });

      const refused = await deliverWebhook(body);
      expect(refused.status).toBe(502);
      const rows = await db.select().from(schema.notifications).orderBy(schema.notifications.userId);
      expect(rows.map((row) => row.userId)).toEqual([USERS.fin, USERS.own].sort());
      const first = rows[0];
      if (first === undefined) throw new Error("notification row missing");
      expect(first.eventType).toBe("payment.unbookable");
      expect(first.aggregateType).toBe("invoice");
      expect(first.aggregateId).toBe(draft.id);
      expect(first.payload).toMatchObject({
        channel: "paypal",
        reasonCode: "not_issued",
        invoiceNumber: draft.number,
        amountCents: 20000,
      });
      expect(notifyCalls).toEqual([[USERS.fin, USERS.own].sort()]);

      // 重投：同一把 dedupe_key，零新行、零再催，响应照旧 502；确认后记账成功
      notifyCalls.length = 0;
      expect((await deliverWebhook(body)).status).toBe(502);
      expect(await notificationCount()).toBe(2);
      expect(notifyCalls).toEqual([]);
      await app.request(`/api/invoices/${draft.id}/confirm`, { method: "POST", headers: fin });
      expect((await deliverWebhook(body)).status).toBe(200);
      expect(await paymentRowCount()).toBe(1);
    });

    it("tells finance about a capture failure after an approved order (dedupe key pins the order)", async () => {
      const invoice = await seedIssuedInvoice();
      const orderId = "ORDER-STUCK-1";
      state.captureBehavior = "fail";
      expect((await deliverWebhook(orderApprovedEvent({ orderId, invoiceId: invoice.id }))).status).toBe(502);

      const rows = await db.select().from(schema.notifications);
      expect(rows).toHaveLength(2);
      const first = rows[0];
      if (first === undefined) throw new Error("notification row missing");
      expect(first.payload).toMatchObject({
        channel: "paypal",
        reasonCode: "capture_failed",
        externalId: orderId,
      });
      expect(String(first.payload.detail)).toContain("failed to capture");
      // APPROVED 重投：capture 再失败，同一把 dedupe_key，零新行
      expect((await deliverWebhook(orderApprovedEvent({ orderId, invoiceId: invoice.id }))).status).toBe(502);
      expect(await notificationCount()).toBe(2);
      expect(await paymentRowCount()).toBe(0);
    });
  });

  describe("approved order → server capture", () => {
    it("captures an approved order for an issued invoice; booking rides the capture event", async () => {
      const invoice = await seedIssuedInvoice();
      const res = await deliverWebhook(orderApprovedEvent({ orderId: "ORDER-77", invoiceId: invoice.id }));
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ received: true, capture: "completed" });
      expect(state.captures).toHaveLength(1);
      expect(state.captures[0]).toContain("/v2/checkout/orders/ORDER-77/capture");
    });

    it("skips capture for a draft invoice and leaves the money unmoved", async () => {
      const draft = await seedDraftInvoice();
      const res = await deliverWebhook(orderApprovedEvent({ orderId: "ORDER-78", invoiceId: draft.id }));
      expect(res.status).toBe(200);
      expect(state.captures).toHaveLength(0); // fail-safe：订单过期，客户不被扣款
      expect(await paymentRowCount()).toBe(0);
    });

    it("skips capture for orders without our anchor", async () => {
      const res = await deliverWebhook(orderApprovedEvent({ orderId: "ORDER-79", invoiceId: null }));
      expect(res.status).toBe(200);
      expect(state.captures).toHaveLength(0);
    });

    it("acks an already-captured replay instead of failing", async () => {
      const invoice = await seedIssuedInvoice();
      state.captureBehavior = "already";
      const res = await deliverWebhook(orderApprovedEvent({ orderId: "ORDER-80", invoiceId: invoice.id }));
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ capture: "already_captured" });
    });

    it("asks PayPal to redeliver (502) when the capture call fails", async () => {
      const invoice = await seedIssuedInvoice();
      state.captureBehavior = "fail";
      const res = await deliverWebhook(orderApprovedEvent({ orderId: "ORDER-81", invoiceId: invoice.id }));
      expect(res.status).toBe(502);
      expect((res.json as { error: string }).error).toBe("capture_failed");
    });
  });
});

/** 未设 DATABASE_URL 时的占位（套件整体 skip，不执行；收集阶段会跑到这里） */
function adminUrl(url: string | undefined): string {
  if (!url) return ""; // 套件被跳过时不会被用到
  const parsed = new URL(url);
  parsed.pathname = "/postgres";
  return parsed.toString();
}
