import { Hono } from "hono";
import type { Logger } from "pino";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";
import { requirePermission } from "../authz/middleware.ts";
import { recordAudit } from "../audit/audit-log.ts";
import { sumLineTotals } from "../billing/service.ts";
import type { StripeChannel } from "../billing/stripe.ts";
import { stripeMisconfigured } from "../billing/stripe.ts";

/**
 * Stripe checkout 端点（#193 的财务过渡面）：给一张**已发出**的发票建支付链接。
 *
 * 客户门户（M1 #186）还没有登录身份与发票归属映射（发票 → 客户要等订单域
 * #231 给出 subject 锚点才有处可查），「支付他人发票」的门随门户面进场；本切片
 * 把同一条服务路径先开给财务——`invoices.manage` 权限点后面，财务确认发票后
 * 把链接发给客户（R-12-6 之后的收款动作）。门户面将来复用同一个
 * StripeGateway + 归属校验，不新增第二套建会话的路径。
 *
 * 金额纪律（#193 验收「篡改金额被拒」的结构性答案）：body 里**没有金额字段
 * 可传**——金额 = 发票行实时合计（发出后行锁定，恒定），币种从发票行抄录，
 * 会话 metadata 带发票 id 供 webhook 自动匹配。$0 票没有可收的钱
 * （computePaymentStatus 的 vacuously paid），拒绝建链接。
 */

export function stripeCheckoutRoutes(deps: { db: Db; logger: Logger; stripe: StripeChannel | undefined }) {  const app = new Hono<AppEnv>();

  app.post("/api/invoices/:id/stripe-checkout", requirePermission("invoices.manage"), async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (deps.stripe === undefined) {
      stripeMisconfigured(deps.logger, "stripe checkout");
      return c.json({ error: "misconfigured" }, 500);
    }
    // 读票与合计（不加行锁：session 的生存期跨越后续的 confirm/void 是常态，
    // 钱能不能记由 webhook 面的状态门兜底，这里锁了也锁不住 24 小时）
    const found = await deps.db
      .select({ number: schema.invoices.number, status: schema.invoices.status, currency: schema.invoices.currency })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, id.data))
      .limit(1);
    const invoice = found[0];
    if (invoice === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    if (invoice.status === "void") {
      return c.json({ error: "invoice_voided" }, 409);
    }
    if (invoice.status !== "issued") {
      return c.json({ error: "not_issued" }, 409);
    }
    const totalCents = await sumLineTotals(deps.db, id.data);
    if (totalCents <= 0) {
      return c.json({ error: "nothing_to_collect" }, 409);
    }
    const base = deps.stripe.webAppUrl.replace(/\/+$/, "");
    const returnPath = `/portal/invoices/${id.data}`;
    const session = await deps.stripe.gateway.createCheckoutSession({
      invoiceId: id.data,
      invoiceNumber: invoice.number,
      amountCents: totalCents,
      currency: invoice.currency,
      // {CHECKOUT_SESSION_ID} 是 Stripe 官方占位符，回跳页用它查询会话状态
      successUrl: `${base}${returnPath}?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}${returnPath}?stripe=cancel`,
    });
    const actorId = c.get("user").id;
    await recordAudit(deps.db, {
      actor: actorId,
      action: "invoice.payment_link_created",
      target: id.data,
      detail: {
        invoiceNumber: invoice.number,
        amountCents: totalCents,
        currency: invoice.currency,
        sessionId: session.id,
      },
    });
    return c.json(
      {
        invoiceId: id.data,
        number: invoice.number,
        sessionId: session.id,
        url: session.url,
        amountCents: totalCents,
        currency: invoice.currency,
      },
      201,
    );
  });

  return app;
}
