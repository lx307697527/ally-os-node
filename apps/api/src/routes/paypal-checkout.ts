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
  computeSurchargeCents,
  PAYPAL_SURCHARGE_RULE_KEY,
  surchargeRateSchema,
} from "../billing/surcharge.ts";
import { effectiveDueCents, sumCreditCents } from "../billing/credits.ts";
import { sumLineTotals } from "../billing/service.ts";
import type { PayPalChannel } from "../billing/paypal.ts";
import { payPalMisconfigured } from "../billing/paypal.ts";
import { getRule, RuleNotFoundError, RuleNotSetError, RuleShapeError } from "../rules/service.ts";

/**
 * PayPal checkout 端点（#193 的财务过渡面，stripe-checkout.ts 同构）：给一张
 * **已发出**的发票建 PayPal 订单，返回审批跳转 URL。
 *
 * 客户门户（M1 #186）还没有登录身份与发票归属映射，「支付他人发票」的门随门户
 * 面进场；本切片把同一条服务路径开给财务——`invoices.manage` 权限点后面，财务
 * 确认发票后把审批链接发给客户（R-12-6 之后的收款动作）。门户面将来复用同一个
 * PayPalGateway，不新增第二套建订单的路径。
 *
 * 金额纪律（#193 验收「篡改金额被拒」的结构性答案，Stripe 同款）：body 里**没有
 * 金额字段可传**——principal = 有效应付（发票行实时合计 − 有效贷项，#192 红冲
 * 切片；发出后行锁定、贷项边界行锁内校验，两者恒定），币种从发票行抄录，锚点
 * 与拆分声明坐服务端写下的 custom_id（billing/paypal.ts 文件头）。$0 有效应付
 * （全冲抵或 $0 票）没有可收的钱，拒绝建订单。
 *
 * 附加费（R-12-2/3）：实扣额 = principal + surcharge，费率读规则注册表
 * `payments.paypal_surcharge_pct`（0021 种子 3.9%，与卡片费率刻意两个键——两个
 * 渠道的费率独立可调）。发票面金额不变；声明搭 custom_id 回去供 webhook 对账
 * （四种命名拒绝与 Stripe 渠道一字不差）。0% = 关闸：裸 custom_id，与无费订单
 * 同形。读不出/出消费方边界 → 409 `surcharge_rule_unusable` fail closed
 * （修复动作是去配置工作室改值；细节进日志不进响应体）。
 *
 * 批准 ≠ 扣款：客户在 PayPal 批准后由 CHECKOUT.ORDER.APPROVED webhook 驱动
 * 服务端 capture（billing/paypal.ts 文件头第 3 条），本端点的产出只有审批链接
 * 与审计——回跳页（`?paypal=return|cancel`）将来只做提示，不做 capture。
 */
export function paypalCheckoutRoutes(deps: { db: Db; logger: Logger; paypal: PayPalChannel | undefined }) {
  const app = new Hono<AppEnv>();

  app.post("/api/invoices/:id/paypal-checkout", requirePermission("invoices.manage"), async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (deps.paypal === undefined) {
      payPalMisconfigured(deps.logger, "paypal checkout");
      return c.json({ error: "misconfigured" }, 500);
    }
    // 读票与合计（不加行锁：订单的生存期跨越后续的 confirm/void 是常态，钱能
    // 不能记由 capture/记账两道状态门兜底——stripe-checkout.ts 同注）
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
    // 贷项单确认后票欠得少了，订单不能按原面额把客户多收一遍
    const invoiceTotalCents = await sumLineTotals(deps.db, id.data);
    const creditedCents = await sumCreditCents(deps.db, id.data);
    const principalCents = effectiveDueCents(invoiceTotalCents, creditedCents);
    if (principalCents <= 0) {
      return c.json({ error: "nothing_to_collect" }, 409);
    }
    // 费率读注册表（消费方 zod 收口）；三种读不出同答 409——stripe-checkout 同裁
    let ratePct: number;
    try {
      ratePct = await getRule(deps.db, PAYPAL_SURCHARGE_RULE_KEY, surchargeRateSchema);
    } catch (err) {
      if (err instanceof RuleNotFoundError || err instanceof RuleNotSetError || err instanceof RuleShapeError) {
        deps.logger.error(
          { ruleKey: PAYPAL_SURCHARGE_RULE_KEY, reason: err.name },
          "paypal surcharge rule unusable; refusing to create an order",
        );
        return c.json({ error: "surcharge_rule_unusable" }, 409);
      }
      throw err;
    }
    const surchargeCents = computeSurchargeCents(principalCents, ratePct);
    const base = deps.paypal.webAppUrl.replace(/\/+$/, "");
    const returnPath = `/portal/invoices/${id.data}`;
    const order = await deps.paypal.gateway.createOrder({
      invoiceId: id.data,
      invoiceNumber: invoice.number,
      amountCents: principalCents,
      ...(surchargeCents > 0 ? { surchargeCents } : {}),
      currency: invoice.currency,
      // 回跳页只做提示（#193 要点原文「付款状态以 webhook 为准」）；capture 由
      // APPROVED webhook 驱动，回跳永远不触发钱的行为
      returnUrl: `${base}${returnPath}?paypal=return`,
      cancelUrl: `${base}${returnPath}?paypal=cancel`,
    });
    const grossCents = principalCents + surchargeCents;
    const actorId = c.get("user").id;
    await recordAudit(deps.db, {
      actor: actorId,
      action: "invoice.payment_link_created",
      target: id.data,
      detail: {
        provider: "paypal",
        invoiceNumber: invoice.number,
        amountCents: grossCents,
        principalCents,
        surchargeCents,
        currency: invoice.currency,
        orderId: order.id,
      },
    });
    return c.json(
      {
        invoiceId: id.data,
        number: invoice.number,
        orderId: order.id,
        url: order.approveUrl,
        // 客户在 PayPal 看到并支付的是 gross；拆分给财务的披露面
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
