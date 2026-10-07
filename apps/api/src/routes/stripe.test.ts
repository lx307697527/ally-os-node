import { randomUUID } from "node:crypto";
import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { StripeChannel } from "../billing/stripe.ts";
import type { SessionData } from "../auth/session.ts";

/**
 * Stripe 渠道端到端集成测试（#193）：checkout 链接创建（财务面）+ webhook 验签
 * 与幂等记账（provider 面）。需要真实 PostgreSQL（发票状态门、收款唯一索引、
 * 审计、同事务原子性）；未设 DATABASE_URL 时跳过。
 *
 * webhook 的请求按 Stripe 的真实线格式构造：先有原始字节，再对原始字节签
 * `Stripe-Signature`——与 billing/stripe.test.ts 的纯函数面互补，这里证明的是
 * 「签名 → 解析 → 记账 → 审计」整条链（含挂在会话中间件之前的路由顺序）。
 */
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

const WEBHOOK_SECRET = "whsec_test_secret";
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

interface RecordedCall {
  invoiceId: string;
  invoiceNumber: string;
  amountCents: number;
  surchargeCents?: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
}

/** 可编程的假网关：记录入参、吐出固定的 session；需要失败时用 rejectNext */
function fakeGateway() {
  const state: { calls: RecordedCall[]; rejectNext: boolean } = { calls: [], rejectNext: false };
  const gateway = {
    createCheckoutSession: (input: RecordedCall) => {
      if (state.rejectNext) {
        state.rejectNext = false;
        return Promise.reject(new Error("stripe unreachable"));
      }
      state.calls.push(input);
      return Promise.resolve({
        id: `cs_test_${String(state.calls.length)}`,
        url: `https://checkout.stripe.com/c/pay/cs_${String(state.calls.length)}`,
      });
    },
  };
  return { gateway, state };
}

function channel(gateway: ReturnType<typeof fakeGateway>["gateway"]): StripeChannel {
  return { gateway, webhookSecret: WEBHOOK_SECRET, webAppUrl: WEB_APP_URL };
}

/** Stripe 线格式的签名头（与 billing/stripe.test.ts 同一算法，这里走真实 HTTP 面） */
function stripeSignature(body: string, secret = WEBHOOK_SECRET, atSeconds = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac("sha256", secret).update(`${String(atSeconds)}.${body}`).digest("hex");
  return `t=${String(atSeconds)},v1=${mac}`;
}

function checkoutCompletedEvent(input: {
  invoiceId: string;
  /** Stripe 报的总额（gross）：有拆分 metadata 时 = principal + surcharge */
  amountCents: number;
  paymentIntent?: string;
  sessionId?: string;
  /** surcharged session 的拆分键（Stripe metadata 是字符串线格式）；缺省 = 普通会话 */
  split?: { principalCents: number; surchargeCents: number };
}): string {
  return JSON.stringify({
    id: `evt_${randomUUID()}`,
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000) - 60, // 钱一分钟前到账
    data: {
      object: {
        id: input.sessionId ?? `cs_${randomUUID()}`,
        payment_intent: input.paymentIntent ?? `pi_${randomUUID()}`,
        amount_total: input.amountCents,
        amount_received: input.amountCents,
        currency: "usd",
        metadata: {
          invoice_id: input.invoiceId,
          ...(input.split !== undefined
            ? {
                principal_amount_cents: String(input.split.principalCents),
                surcharge_amount_cents: String(input.split.surchargeCents),
              }
            : {}),
        },
      },
    },
  });
}

describe.skipIf(!databaseUrl)("stripe checkout & webhook (#193, integration)", () => {
  const dbName = `stripe_test_${String(Date.now())}_${String(process.pid)}`;
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

  const gateway = fakeGateway();
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
    stripe: channel(gateway.gateway),
  });

  // 同一夹具的「渠道未配置」变体：webhook 与 checkout 都必须 fail closed
  const appWithoutStripe = createApp({
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
    stripe: undefined,
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
    await db.insert(schema.numberingRules).values({
      subject: "invoice",
      label: "Invoice",
      prefix: "INV-",
      dateFormat: null,
      padding: 4,
      startNumber: 3000,
    });
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table ${schema.payments}, ${schema.invoiceLines}, ${schema.invoices} cascade`);
    await db.execute(sql`truncate table ${schema.auditEvents}`);
    gateway.state.calls = [];
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

  async function deliverWebhook(
    body: string,
    headers: Record<string, string> = { "stripe-signature": stripeSignature(body) },
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await app.request("/api/webhooks/stripe", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  describe("checkout link (finance face)", () => {
    it("creates a session for an issued invoice with the R-12-2/3 surcharge disclosed", async () => {
      const invoice = await seedIssuedInvoice(); // principal 150000，种子费率 3.9%
      const res = await app.request(`/api/invoices/${invoice.id}/stripe-checkout`, {
        method: "POST",
        headers: fin,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        sessionId: string;
        url: string;
        amountCents: number;
        principalCents: number;
        surchargeCents: number;
        currency: string;
      };
      // 客户被实扣 gross = principal + 3.9%；发票面金额不变，拆分给披露面
      expect(body.amountCents).toBe(155850);
      expect(body.principalCents).toBe(150000);
      expect(body.surchargeCents).toBe(5850);
      expect(body.currency).toBe("USD");
      expect(body.url).toContain("checkout.stripe.com");

      // principal 与锚点都是服务端出的：网关收到的入参里没有客户端可塞的金额口子
      const call = gateway.state.calls[0];
      if (call === undefined) throw new Error("gateway not called");
      expect(call.amountCents).toBe(150000);
      expect(call.surchargeCents).toBe(5850);
      expect(call.currency).toBe("USD");
      expect(call.invoiceId).toBe(invoice.id);
      expect(call.successUrl).toBe(
        `${WEB_APP_URL}/portal/invoices/${invoice.id}?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      );
      expect(call.cancelUrl).toBe(`${WEB_APP_URL}/portal/invoices/${invoice.id}?stripe=cancel`);

      const audits = await db
        .select({ detail: schema.auditEvents.detail })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.action, "invoice.payment_link_created"));
      expect(audits).toHaveLength(1);
      // 审计按实扣额记，拆分随行——「给谁发过链接、按多少钱发的」可查
      expect(audits[0]?.detail).toMatchObject({
        amountCents: 155850,
        principalCents: 150000,
        surchargeCents: 5850,
      });
    });

    it("treats a 0% rate as the kill switch: an ordinary session with no surcharge", async () => {
      const ruleKey = "payments.card_surcharge_pct";
      try {
        await db.update(schema.registryRules).set({ value: 0 }).where(eq(schema.registryRules.key, ruleKey));
        const invoice = await seedIssuedInvoice();
        const res = await app.request(`/api/invoices/${invoice.id}/stripe-checkout`, {
          method: "POST",
          headers: fin,
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { amountCents: number; surchargeCents: number };
        expect(body.amountCents).toBe(150000); // gross = principal
        expect(body.surchargeCents).toBe(0);
        const call = gateway.state.calls[0];
        if (call === undefined) throw new Error("gateway not called");
        expect(call.surchargeCents).toBeUndefined(); // 普通会话：没有拆分可传
      } finally {
        await db.update(schema.registryRules).set({ value: 3.9 }).where(eq(schema.registryRules.key, ruleKey));
      }
    });

    it("refuses to create sessions while the surcharge rule is unusable (fail closed)", async () => {
      const ruleKey = "payments.card_surcharge_pct";
      try {
        // 待填（null）与出消费方边界（6% > 5% 护栏）都收不了钱
        for (const broken of [null, 6]) {
          await db.update(schema.registryRules).set({ value: broken }).where(eq(schema.registryRules.key, ruleKey));
          const invoice = await seedIssuedInvoice();
          const res = await app.request(`/api/invoices/${invoice.id}/stripe-checkout`, {
            method: "POST",
            headers: fin,
          });
          expect(res.status).toBe(409);
          expect(((await res.json()) as { error: string }).error).toBe("surcharge_rule_unusable");
        }
        expect(gateway.state.calls).toHaveLength(0); // 一次会话都没建
      } finally {
        await db.update(schema.registryRules).set({ value: 3.9 }).where(eq(schema.registryRules.key, ruleKey));
      }
    });

    it("refuses drafts, voided and zero-total invoices; enforces invoices.manage", async () => {
      const draft = await seedDraftInvoice();
      const onDraft = await app.request(`/api/invoices/${draft.id}/stripe-checkout`, { method: "POST", headers: fin });
      expect(onDraft.status).toBe(409);
      expect(((await onDraft.json()) as { error: string }).error).toBe("not_issued");

      await app.request(`/api/invoices/${draft.id}/void`, { method: "POST", headers: fin });
      const onVoid = await app.request(`/api/invoices/${draft.id}/stripe-checkout`, { method: "POST", headers: fin });
      expect(onVoid.status).toBe(409);
      expect(((await onVoid.json()) as { error: string }).error).toBe("invoice_voided");

      const zero = await seedIssuedInvoice([
        { description: "Courtesy", quantity: 1, unitPriceCents: 0 },
      ]);
      const onZero = await app.request(`/api/invoices/${zero.id}/stripe-checkout`, { method: "POST", headers: fin });
      expect(onZero.status).toBe(409);
      expect(((await onZero.json()) as { error: string }).error).toBe("nothing_to_collect");

      const invoice = await seedIssuedInvoice();
      expect(
        (await app.request(`/api/invoices/${invoice.id}/stripe-checkout`, { method: "POST", headers: sal })).status,
      ).toBe(403);
      expect(
        (await app.request(`/api/invoices/${invoice.id}/stripe-checkout`, { method: "POST", headers: own })).status,
      ).toBe(201);
      expect(
        (await app.request(`/api/invoices/${randomUUID()}/stripe-checkout`, { method: "POST", headers: fin })).status,
      ).toBe(404);

      expect(gateway.state.calls).toHaveLength(1); // 只有 owner 那次真建了会话
    });

    it("answers misconfigured when the channel is not enabled (fail closed)", async () => {
      const invoice = await seedIssuedInvoice();
      const res = await appWithoutStripe.request(`/api/invoices/${invoice.id}/stripe-checkout`, {
        method: "POST",
        headers: fin,
      });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toBe("misconfigured");
    });
  });

  describe("webhook (provider face)", () => {
    it("walks the full loop: signed event → payment row → audit → paid invoice", async () => {
      const invoice = await seedIssuedInvoice();
      const body = checkoutCompletedEvent({ invoiceId: invoice.id, amountCents: 150000 });
      const res = await deliverWebhook(body);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ received: true, invoiceNumber: invoice.number, paymentStatus: "paid" });

      const rows = await db.select().from(schema.payments);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row === undefined) throw new Error("payment row missing");
      expect(row.method).toBe("card");
      expect(row.amountCents).toBe(150000);
      expect(row.currency).toBe("USD");
      expect(row.sourceType).toBe("stripe");
      expect(row.sourceKey).toMatch(/^pi_/);
      expect(row.recordedById).toBeNull(); // webhook 记账无用户上下文
      expect(row.voidedAt).toBeNull();

      const detail = await app.request(`/api/invoices/${invoice.id}`, { headers: fin });
      expect(((await detail.json()) as InvoiceJson).paymentStatus).toBe("paid");

      const audits = await db
        .select({ detail: schema.auditEvents.detail, actor: schema.auditEvents.actor })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.action, "payment.recorded"));
      expect(audits).toHaveLength(1);
      expect(audits[0]?.actor).toBeNull();
      expect(audits[0]?.detail).toMatchObject({ sourceType: "stripe", invoiceId: invoice.id, amountCents: 150000 });
    });

    it("books a surcharged capture as principal + fee; the fee never touches the invoice face", async () => {
      const invoice = await seedIssuedInvoice(); // principal 150000
      const body = checkoutCompletedEvent({
        invoiceId: invoice.id,
        amountCents: 155850, // Stripe 实扣 gross
        split: { principalCents: 150000, surchargeCents: 5850 },
      });
      const res = await deliverWebhook(body);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ received: true, invoiceNumber: invoice.number, paymentStatus: "paid" });

      const rows = await db.select().from(schema.payments);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row === undefined) throw new Error("payment row missing");
      expect(row.amountCents).toBe(150000); // 结清额进台账，paid 派生的唯一口径
      expect(row.surchargeCents).toBe(5850); // 费在旁边，不参与 SUM
      expect(row.method).toBe("card");

      const audits = await db
        .select({ detail: schema.auditEvents.detail })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.action, "payment.recorded"));
      expect(audits).toHaveLength(1);
      expect(audits[0]?.detail).toMatchObject({ amountCents: 150000, surchargeCents: 5850 });
    });

    it("refuses to bank a surcharged capture that does not reconcile (502, zero side effects)", async () => {
      // 建会话后费率被改过 / metadata 被动过：报出的拆分与实扣额对不上——
      // 一个数字是错的而这里无法分辨，什么都不入账，502 让 Stripe 重投
      const invoice = await seedIssuedInvoice();
      const mismatched = await deliverWebhook(
        checkoutCompletedEvent({
          invoiceId: invoice.id,
          amountCents: 155000,
          split: { principalCents: 150000, surchargeCents: 5850 },
        }),
      );
      expect(mismatched.status).toBe(502);
      const halfDeclared = await deliverWebhook(
        JSON.stringify({
          id: `evt_${randomUUID()}`,
          type: "checkout.session.completed",
          created: Math.floor(Date.now() / 1000) - 60,
          data: {
            object: {
              id: `cs_${randomUUID()}`,
              payment_intent: `pi_${randomUUID()}`,
              amount_total: 155850,
              amount_received: 155850,
              metadata: { invoice_id: invoice.id, surcharge_amount_cents: "5850" },
            },
          },
        }),
      );
      expect(halfDeclared.status).toBe(502);

      expect(await paymentRowCount()).toBe(0);
      expect(await auditCount("payment.recorded")).toBe(0);
    });

    it("is idempotent across replays and completed+succeeded double sends", async () => {
      const invoice = await seedIssuedInvoice();
      const paymentIntent = `pi_${randomUUID()}`;
      const completed = checkoutCompletedEvent({ invoiceId: invoice.id, amountCents: 150000, paymentIntent });

      expect((await deliverWebhook(completed)).status).toBe(200);
      // 原样重放：已记账成功，200，不再落行
      const replay = await deliverWebhook(completed);
      expect(replay.json).toMatchObject({ received: true, replay: true });
      // 同一笔钱的 payment_intent.succeeded：同一 externalId，幂等重放
      const succeededBody = JSON.stringify({
        id: `evt_${randomUUID()}`,
        type: "payment_intent.succeeded",
        created: Math.floor(Date.now() / 1000) - 30,
        data: { object: { id: paymentIntent, amount_received: 150000, metadata: { invoice_id: invoice.id } } },
      });
      const doubleSend = await deliverWebhook(succeededBody);
      expect(doubleSend.json).toMatchObject({ received: true, replay: true });

      expect(await paymentRowCount()).toBe(1);
      expect(await auditCount("payment.recorded")).toBe(1);
    });

    it("refuses unsigned, wrongly-signed and stale deliveries with zero side effects", async () => {
      const invoice = await seedIssuedInvoice();
      const body = checkoutCompletedEvent({ invoiceId: invoice.id, amountCents: 150000 });

      const unsigned = await deliverWebhook(body, {});
      expect(unsigned.status).toBe(401);
      const wrongSecret = await deliverWebhook(body, {
        "stripe-signature": stripeSignature(body, "whsec_attacker"),
      });
      expect(wrongSecret.status).toBe(401);
      const staleAt = Math.floor(Date.now() / 1000) - 3600;
      const stale = await deliverWebhook(body, {
        "stripe-signature": stripeSignature(body, WEBHOOK_SECRET, staleAt),
      });
      expect(stale.status).toBe(401);

      // GET / PUT 都不是投递（POST-only）
      expect((await app.request("/api/webhooks/stripe", { headers: fin })).status).toBe(405);

      expect(await paymentRowCount()).toBe(0);
      expect(await auditCount("payment.recorded")).toBe(0);
    });

    it("asks Stripe to redeliver money on an unconfirmed invoice, and books it after finance confirms", async () => {
      const draft = await seedDraftInvoice();
      const body = checkoutCompletedEvent({ invoiceId: draft.id, amountCents: 20000 });

      const beforeConfirm = await deliverWebhook(body);
      expect(beforeConfirm.status).toBe(502);
      expect((beforeConfirm.json as { error: string }).error).toBe("not_issued");
      expect(await paymentRowCount()).toBe(0);

      // 财务确认（R-12-6 人的闸门）后，Stripe 的重投成功记账——钱没有丢
      const confirmed = await app.request(`/api/invoices/${draft.id}/confirm`, { method: "POST", headers: fin });
      expect(confirmed.status).toBe(200);
      const afterConfirm = await deliverWebhook(body);
      expect(afterConfirm.status).toBe(200);
      expect((afterConfirm.json as { paymentStatus: string }).paymentStatus).toBe("paid");
      expect(await paymentRowCount()).toBe(1);
    });

    it("keeps refusing money for voided and unknown invoices (502, never ack)", async () => {
      const draft = await seedDraftInvoice();
      await app.request(`/api/invoices/${draft.id}/void`, { method: "POST", headers: fin });
      const onVoid = await deliverWebhook(checkoutCompletedEvent({ invoiceId: draft.id, amountCents: 20000 }));
      expect(onVoid.status).toBe(502);
      expect((onVoid.json as { error: string }).error).toBe("invoice_voided");

      const unknown = await deliverWebhook(checkoutCompletedEvent({ invoiceId: randomUUID(), amountCents: 100 }));
      expect(unknown.status).toBe(502);
      expect((unknown.json as { error: string }).error).toBe("invoice_not_found");

      expect(await paymentRowCount()).toBe(0);
      expect(await auditCount("payment.recorded")).toBe(0);
    });

    it("acks deliveries with nothing to book (other event types, no invoice metadata)", async () => {
      await seedIssuedInvoice();
      const ignored = JSON.stringify({
        id: `evt_${randomUUID()}`,
        type: "checkout.session.async_payment_failed",
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: `cs_${randomUUID()}` } },
      });
      expect((await deliverWebhook(ignored)).status).toBe(200);

      // 钱进了账户但没有发票锚点（不是本系统建的 session）：ack，留给 #181 认领
      const unanchored = JSON.stringify({
        id: `evt_${randomUUID()}`,
        type: "checkout.session.completed",
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: `cs_${randomUUID()}`, amount_total: 100 } },
      });
      const unanchoredRes = await deliverWebhook(unanchored);
      expect(unanchoredRes.status).toBe(200);
      expect((unanchoredRes.json as { received: boolean }).received).toBe(true);

      expect(await paymentRowCount()).toBe(0);
    });

    it("answers 400 for a correctly-signed but unparseable payload, 500 misconfigured without the channel", async () => {
      const garbage = "{{not json";
      const signed = await deliverWebhook(garbage, { "stripe-signature": stripeSignature(garbage) });
      expect(signed.status).toBe(400);

      const invoice = await seedIssuedInvoice();
      const res = await appWithoutStripe.request("/api/webhooks/stripe", {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": "whatever" },
        body: checkoutCompletedEvent({ invoiceId: invoice.id, amountCents: 100 }),
      });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toBe("misconfigured");
    });

    it("records a partial capture as the bank fact it is (derived status goes partial)", async () => {
      // 客户用错了旧链接/部分入账：Stripe 签过名的金额是唯一事实，付款态按 SUM
      // 派生为 partial——记账诚实地反映「钱进了一半」，不假装也不拒绝
      const invoice = await seedIssuedInvoice();
      const res = await deliverWebhook(checkoutCompletedEvent({ invoiceId: invoice.id, amountCents: 50000 }));
      expect(res.status).toBe(200);
      expect((res.json as { paymentStatus: string }).paymentStatus).toBe("partial");
      const detail = await app.request(`/api/invoices/${invoice.id}`, { headers: fin });
      expect(((await detail.json()) as InvoiceJson).paidCents).toBe(50000);
    });
  });
});

/** 未设 DATABASE_URL 时的占位（套件整体 skip，不执行） */
function adminUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) return ""; // 套件被跳过时不会被用到
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}
