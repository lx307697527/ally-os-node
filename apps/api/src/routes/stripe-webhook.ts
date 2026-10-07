import { Hono } from "hono";
import type { Logger } from "pino";
import type { Db } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";
import { recordAudit } from "../audit/audit-log.ts";
import { PaymentExistsError, PaymentStateError, recordPayment } from "../billing/payments.ts";
import type { StripeChannel } from "../billing/stripe.ts";
import { normalizeStripeEvent, stripeMisconfigured, verifyStripeSignature } from "../billing/stripe.ts";

/**
 * Stripe webhook 端点（#193）。挂在会话中间件**之前**（app.ts）：Stripe 没有本
 * 系统会话，这一面的认证就是 Stripe-Signature 验签本身——原始字节先过 HMAC，
 * 再谈解析。签名不过 401 且零副作用；渠道未配置 500 misconfigured（fail closed：
 * 配置缺失是部署问题，不是认证失败）。
 *
 * 响应契约（Stripe 按非 2xx 重投）：
 * - 200 `{ received: true }` —— 记账成功 / 幂等重放（已记账）/ 无关事件 / 无锚点
 *   入账（metadata 缺席：不是发票支付，认领面随 #181 进场）；
 * - 502 —— 钱到了但这边记不了：票未确认（not_issued）/ 已作废（invoice_voided）/
 *   找不到（invoice_not_found）/ 事件读不出可信金额。**绝不 2xx 确认记不了的钱**
 *   ——确认一次，这笔钱就永远收不回来了；重投等财务确认（R-12-6 是人的闸门，
 *   webhook 靠 provider 重试跨过它，billing/payments.ts 文件头同文）。
 *
 * 幂等：source = ("stripe", externalId)（payment_intent ?? 对象 id）——重放/双发
 * （completed + succeeded 对同一笔钱）撞 payments_source_idx，PaymentExistsError
 * 被「已记账成功」语义吃掉回 200。审计与记账同事务：commit 前任何一步失败整体
 * 回滚，重投时从原点重来，不存在「钱记了、审计没了」的中间态。
 */

export function stripeWebhookRoutes(deps: { db: Db; logger: Logger; stripe: StripeChannel | undefined }) {
  const app = new Hono<AppEnv>();

  // 方法集合显式枚举（不用 app.all）：路由普查（route-auth.test.ts）按 method
  // 逐条对册，ALL 会被当成中间件漏掉——注册表承诺的是完整路由册。非 POST 在
  // 处理器第一行拒绝（Stripe 只投 POST）
  app.on(["POST", "GET", "PUT", "PATCH", "DELETE"], "/api/webhooks/stripe", async (c) => {
    if (c.req.method !== "POST") {
      return c.json({ error: "method_not_allowed" }, 405);
    }
    if (deps.stripe === undefined) {
      stripeMisconfigured(deps.logger, "stripe webhook");
      return c.json({ error: "misconfigured" }, 500);
    }
    const rawBody = await c.req.text();
    const verdict = verifyStripeSignature({
      secret: deps.stripe.webhookSecret,
      header: c.req.header("stripe-signature"),
      rawBody,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!verdict.ok) {
      deps.logger.warn({ reason: verdict.reason }, "stripe webhook signature refused");
      return c.json({ error: "unauthorized" }, 401);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "invalid_payload" }, 400);
    }
    const event = normalizeStripeEvent(parsed);
    if (event.kind === "ignored") {
      deps.logger.debug("stripe webhook event ignored (no money to book)");
      return c.json({ received: true });
    }
    if (event.kind === "unparsable") {
      deps.logger.error({ reason: event.reason }, "stripe webhook paid event unparsable; asking Stripe to redeliver");
      return c.json({ error: "unparsable_event" }, 502);
    }
    if (event.invoiceId === null) {
      if (event.invoiceIdInvalid) {
        deps.logger.error({ externalId: event.externalId }, "stripe webhook metadata.invoice_id is not a uuid; asking Stripe to redeliver");
        return c.json({ error: "unparsable_event" }, 502);
      }
      // 钱进了我们的 Stripe 账户但没有发票锚点：不是本系统创建的 session。这里没
      // 有可记账的家（payments.invoice_id 非空），ack 掉让投递结束——认领面随
      // #181（QuickBooks 银行流水）进场后在这里接手
      deps.logger.warn(
        { externalId: event.externalId, amountCents: event.amountCents, eventType: event.eventType },
        "stripe webhook payment without invoice metadata; left unclaimed for #181",
      );
      return c.json({ received: true });
    }

    const invoiceId = event.invoiceId;
    try {
      const recorded = await deps.db.transaction(async (tx) => {
        const booked = await recordPayment(tx, invoiceId, {
          amountCents: event.amountCents,
          method: "card",
          receivedAt: event.receivedAt,
          note: `Stripe ${event.externalId}`,
          source: { type: "stripe", key: event.externalId },
          recordedById: null,
        });
        if (booked !== null) {
          await recordAudit(tx, {
            actor: null,
            action: "payment.recorded",
            target: booked.id,
            detail: {
              invoiceId,
              invoiceNumber: booked.number,
              amountCents: event.amountCents,
              method: "card",
              paymentStatus: booked.paymentStatus,
              paidCents: booked.paidCents,
              totalCents: booked.totalCents,
              sourceType: "stripe",
              sourceKey: event.externalId,
              eventType: event.eventType,
            },
          });
        }
        return booked;
      });
      if (recorded === null) {
        deps.logger.error({ invoiceId, externalId: event.externalId }, "stripe webhook payment for unknown invoice; asking Stripe to redeliver");
        return c.json({ error: "invoice_not_found" }, 502);
      }
      deps.logger.info(
        { invoiceId, invoiceNumber: recorded.number, amountCents: event.amountCents, paymentStatus: recorded.paymentStatus, externalId: event.externalId },
        "stripe webhook payment recorded",
      );
      return c.json({ received: true, invoiceNumber: recorded.number, paymentStatus: recorded.paymentStatus });
    } catch (err) {
      if (err instanceof PaymentExistsError) {
        // 重放 / completed + succeeded 双发：已记账成功，ack 让 Stripe 停止重投
        deps.logger.info({ externalId: event.externalId }, "stripe webhook replay for an already-recorded payment");
        return c.json({ received: true, replay: true });
      }
      if (err instanceof PaymentStateError) {
        deps.logger.warn(
          { invoiceId, externalId: event.externalId, code: err.code },
          "stripe webhook payment refused by invoice state; asking Stripe to redeliver",
        );
        return c.json({ error: err.code }, 502);
      }
      throw err;
    }
  });

  return app;
}
