import { Hono, type Context } from "hono";
import type { Logger } from "pino";
import type { Db } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";
import { recordAudit } from "../audit/audit-log.ts";
import { PaymentExistsError, PaymentStateError, recordPayment } from "../billing/payments.ts";
import {
  PAYMENT_ATTEMPT_FAILED_EVENT,
  PAYMENT_UNBOOKABLE_EVENT,
  type PaymentAlertInput,
  type PaymentAlertChannel,
  recordPaymentAlert,
  unbookableReasonText,
} from "../billing/payment-alerts.ts";
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
 *   入账（metadata 缺席：不是发票支付，认领面随 #181 进场）/ 无锚点的失败尝试
 *   （老裁决：只报带我们锚点的尝试）；失败尝试**带锚点**时，告警就是这一事件的
 *   全部事实——告警写入成功才 200；
 * - 502 —— 事实到了但这边记不下来：钱记不了（票未确认 not_issued / 已作废
 *   invoice_voided / 找不到 invoice_not_found / 事件读不出可信金额 / surcharge
 *   拆分对不上——R-12-2/3，billing/surcharge.ts 的四种命名拒绝），或失败尝试的
 *   告警行写不进（provider 重投会重试，dedupe_key 让它幂等）。**绝不 2xx 确认
 *   记不了的事实**——确认一次，这笔钱/这条提醒就永远收不回来了；钱的重投等
 *   财务确认（R-12-6 是人的闸门，webhook 靠 provider 重试跨过它，
 *   billing/payments.ts 文件头同文）。
 *
 * 站内告警（#193 剩余③）：钱记不了或支付尝试失败 → invoices.manage 持有者的
 * 铃铛一行（老系统 Sentry/Slack 分流的替代面）。502 路径上的告警是尽力面（写不
 * 进只记日志，响应照旧 502——provider 的重投会重试告警写入，dedupe_key 保证
 * 最多一行/人）；失败尝试路径上告警是事件的本体，写不进升级为 502。
 *
 * 幂等：钱的 source = ("stripe", externalId)（payment_intent ?? 对象 id）——重放/
 * 双发（completed + succeeded 对同一笔钱）撞 payments_source_idx，PaymentExistsError
 * 被「已记账成功」语义吃掉回 200；告警的 dedupe_key = 渠道+外部 id+拒绝码
 * （(user_id, dedupe_key) 部分唯一索引）——同一事实的重投最多一行/人。两把唯一
 * 索引各管各的重放。审计与记账同事务：commit 前任何一步失败整体回滚，重投时从
 * 原点重来，不存在「钱记了、审计没了」的中间态。
 */

const CHANNEL: PaymentAlertChannel = "stripe";

export function stripeWebhookRoutes(deps: {
  db: Db;
  logger: Logger;
  stripe: StripeChannel | undefined;
  notifyUsers: (userIds: string[]) => Promise<void>;
}) {
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
    if (event.kind === "payment_failed") {
      return handleFailedAttempt(c, event);
    }
    if (event.kind === "unparsable") {
      deps.logger.error({ reason: event.reason }, "stripe webhook paid event unparsable; asking Stripe to redeliver");
      // 读不出账的钱也是钱：外部 id 读得出的就提醒财务（尽力面——响应照旧 502，
      // 重投会重试告警写入，dedupe_key 保证最多一行/人）
      if (event.externalId !== null) {
        await alertBestEffort({
          eventType: PAYMENT_UNBOOKABLE_EVENT,
          reasonCode: "unparsable_event",
          reason: unbookableReasonText("unparsable_event", event.reason),
          externalId: event.externalId,
          invoiceId: event.invoiceId,
          amountCents: event.grossCents,
          currency: event.currency,
        });
      }
      return c.json({ error: "unparsable_event" }, 502);
    }
    if (event.invoiceId === null) {
      if (event.invoiceIdInvalid) {
        deps.logger.error({ externalId: event.externalId }, "stripe webhook metadata.invoice_id is not a uuid; asking Stripe to redeliver");
        await alertBestEffort({
          eventType: PAYMENT_UNBOOKABLE_EVENT,
          reasonCode: "unparsable_event",
          reason: unbookableReasonText("unparsable_event", "the payment's invoice anchor (metadata.invoice_id) is not a valid invoice id"),
          externalId: event.externalId,
          invoiceId: null,
          amountCents: event.amountCents,
          currency: event.currency,
        });
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
          // amountCents = 结清额（principal）；附加费是拆分出的费成分（R-12-2/3），
          // 不参与 paid 派生——支付态「结清」的口径不因手续费漂移
          amountCents: event.amountCents,
          ...(event.surchargeCents !== null ? { surchargeCents: event.surchargeCents } : {}),
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
              ...(event.surchargeCents !== null ? { surchargeCents: event.surchargeCents } : {}),
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
        await alertBestEffort({
          eventType: PAYMENT_UNBOOKABLE_EVENT,
          reasonCode: "invoice_not_found",
          reason: unbookableReasonText("invoice_not_found", null),
          externalId: event.externalId,
          invoiceId,
          amountCents: event.amountCents,
          currency: event.currency,
        });
        return c.json({ error: "invoice_not_found" }, 502);
      }
      deps.logger.info(
        { invoiceId, invoiceNumber: recorded.number, amountCents: event.amountCents, surchargeCents: event.surchargeCents, paymentStatus: recorded.paymentStatus, externalId: event.externalId },
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
        await alertBestEffort({
          eventType: PAYMENT_UNBOOKABLE_EVENT,
          reasonCode: err.code,
          reason: unbookableReasonText(err.code, null),
          externalId: event.externalId,
          invoiceId,
          amountCents: event.amountCents,
          currency: event.currency,
        });
        return c.json({ error: err.code }, 502);
      }
      throw err;
    }
  });

  /** 支付尝试失败（payment_failed）：告警是这个事件的全部事实，写入成功才 ack */
  async function handleFailedAttempt(
    c: Context<AppEnv>,
    event: Extract<Awaited<ReturnType<typeof normalizeStripeEvent>>, { kind: "payment_failed" }>,
  ): Promise<Response> {
    if (event.invoiceId === null) {
      // 无有效锚点：不是本系统的支付尝试（老裁决 BUG-774：只报带我们 invoice_id
      // 的）——分文未扣、无人可认，ack 让投递结束
      deps.logger.info(
        { externalId: event.externalId, eventType: event.eventType },
        "stripe webhook failed attempt without our invoice anchor; not ours to report",
      );
      return c.json({ received: true });
    }
    try {
      const alerted = await deps.db.transaction((tx) =>
        recordPaymentAlert(tx, {
          eventType: PAYMENT_ATTEMPT_FAILED_EVENT,
          channel: CHANNEL,
          externalId: event.externalId,
          reasonCode: "attempt_failed",
          reason: event.reason,
          invoiceId: event.invoiceId,
          method: event.method,
          amountCents: event.amountCents,
          currency: event.currency,
        }),
      );
      if (alerted.length > 0) await deps.notifyUsers(alerted);
      deps.logger.info(
        { externalId: event.externalId, invoiceId: event.invoiceId, recipients: alerted.length },
        "stripe webhook failed attempt reported to finance",
      );
      return c.json({ received: true });
    } catch (err) {
      // 告警写不进 = 这个事件什么都没留下。502 让 Stripe 重投（dedupe_key 让重投
      // 幂等），绝不 ack 一条没人看见的失败
      deps.logger.error({ err, externalId: event.externalId }, "stripe webhook failed-attempt alert could not be written; asking Stripe to redeliver");
      return c.json({ error: "alert_not_recorded" }, 502);
    }
  }

  /** 502 路径的尽力告警：写不进只记日志——响应照旧 502，provider 的重投会带着
   * 同一把 dedupe_key 再来，告警最多少一行，钱的事实一个不少 */
  async function alertBestEffort(input: Omit<PaymentAlertInput, "channel">): Promise<void> {
    try {
      const alerted = await deps.db.transaction((tx) => recordPaymentAlert(tx, { channel: CHANNEL, ...input }));
      if (alerted.length > 0) {
        deps.logger.info({ reasonCode: input.reasonCode, externalId: input.externalId, recipients: alerted.length }, "stripe webhook unbookable payment reported to finance");
        await deps.notifyUsers(alerted);
      }
    } catch (err) {
      deps.logger.error({ err, reasonCode: input.reasonCode, externalId: input.externalId }, "stripe webhook payment alert could not be written; provider redelivery will retry it");
    }
  }

  return app;
}
