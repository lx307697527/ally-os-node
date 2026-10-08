import { Hono } from "hono";
import type { Logger } from "pino";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";
import { requirePermission } from "../authz/middleware.ts";
import { recordAudit } from "../audit/audit-log.ts";
import {
  CARD_SURCHARGE_RULE_KEY,
  computeSurchargeCents,
  surchargeRateSchema,
} from "../billing/surcharge.ts";
import { effectiveDueCents, sumCreditCents } from "../billing/credits.ts";
import { sumLineTotals } from "../billing/service.ts";
import type { StripeChannel } from "../billing/stripe.ts";
import { stripeMisconfigured } from "../billing/stripe.ts";
import { getRule, RuleNotFoundError, RuleNotSetError, RuleShapeError } from "../rules/service.ts";

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
 * 可传**——principal = 发票行实时合计（发出后行锁定，恒定），币种从发票行抄录，
 * 会话 metadata 带发票 id 供 webhook 自动匹配。$0 票没有可收的钱
 * （computePaymentStatus 的 vacuously paid），拒绝建链接。
 *
 * 附加费（R-12-2/3，本切片）：实扣额 = principal + surcharge，费率读规则注册表
 * `payments.card_surcharge_pct`（0021 种子 3.9%，管理员可调，⚠ 风险标记随行）。
 * 发票面金额不变——费在 checkout 加收、结账前披露，绝不写进发票行；拆分搭
 * session metadata 回去供 webhook 对账（billing/surcharge.ts 文件头的四条拒绝）。
 * 费率为 0 = 管理员关闸：session 与存量无附加费会话完全同形。规则读不出/出
 * 消费方边界 → 409 `surcharge_rule_unusable` fail closed（修复动作是去配置工作
 * 室改值，numbering_not_configured 同一先例；细节进日志不进响应体）。
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
    // 结算额 = 有效应付（发票合计 − 有效贷项，credits.ts 唯一权威算术）：
    // 贷项单确认后票欠得少了，链接不能按原面额把客户多收一遍
    const invoiceTotalCents = await sumLineTotals(deps.db, id.data);
    const creditedCents = await sumCreditCents(deps.db, id.data);
    const principalCents = effectiveDueCents(invoiceTotalCents, creditedCents);
    if (principalCents <= 0) {
      return c.json({ error: "nothing_to_collect" }, 409);
    }
    // 费率读注册表（消费方 zod 收口）；三种读不出同答 409——没种子/待填/形状
    // 不符都是「现在收不了钱」的配置事故，日志里分得清，响应体一视同仁
    let ratePct: number;
    try {
      ratePct = await getRule(deps.db, CARD_SURCHARGE_RULE_KEY, surchargeRateSchema);
    } catch (err) {
      if (err instanceof RuleNotFoundError || err instanceof RuleNotSetError || err instanceof RuleShapeError) {
        deps.logger.error(
          { ruleKey: CARD_SURCHARGE_RULE_KEY, reason: err.name },
          "card surcharge rule unusable; refusing to create a checkout session",
        );
        return c.json({ error: "surcharge_rule_unusable" }, 409);
      }
      throw err;
    }
    const surchargeCents = computeSurchargeCents(principalCents, ratePct);
    const base = deps.stripe.webAppUrl.replace(/\/+$/, "");
    const returnPath = `/portal/invoices/${id.data}`;
    const session = await deps.stripe.gateway.createCheckoutSession({
      invoiceId: id.data,
      invoiceNumber: invoice.number,
      amountCents: principalCents,
      ...(surchargeCents > 0 ? { surchargeCents } : {}),
      currency: invoice.currency,
      // {CHECKOUT_SESSION_ID} 是 Stripe 官方占位符，回跳页用它查询会话状态
      successUrl: `${base}${returnPath}?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}${returnPath}?stripe=cancel`,
    });
    const grossCents = principalCents + surchargeCents;
    const actorId = c.get("user").id;
    await recordAudit(deps.db, {
      actor: actorId,
      action: "invoice.payment_link_created",
      target: id.data,
      detail: {
        invoiceNumber: invoice.number,
        amountCents: grossCents,
        principalCents,
        surchargeCents,
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
        // 客户在结账页看到并支付的是 gross；拆分给财务的披露面
        amountCents: grossCents,
        principalCents,
        surchargeCents,
        currency: invoice.currency,
      },
      201,
    );
  });

  return app;
}
