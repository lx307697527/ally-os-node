import { Hono, type Context } from "hono";
import type { Logger } from "pino";
import { eq } from "drizzle-orm";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";
import { recordAudit } from "../audit/audit-log.ts";
import { PaymentExistsError, PaymentStateError, recordPayment } from "../billing/payments.ts";
import type { NormalizedPayPalEvent, PayPalChannel, PayPalTransmission } from "../billing/paypal.ts";
import { normalizePayPalEvent, payPalMisconfigured } from "../billing/paypal.ts";

/**
 * PayPal webhook 端点（#193）。挂在会话中间件**之前**（app.ts）：PayPal 没有
 * 本系统会话，这一面的认证就是 verify-webhook-signature 活体验签本身（Stripe
 * 的本地 HMAC 在这没有对应物——PayPal 没有共享密钥签名方案，防伪靠
 * server-to-server 验证，billing/paypal.ts 文件头）。渠道未配置 500
 * misconfigured（fail closed：配置缺失是部署问题，不是认证失败）。
 *
 * 响应契约（PayPal 按非 2xx 重投，与 Stripe 渠道同一纪律）：
 * - 200 `{ received: true }` —— 记账成功 / 幂等重放（已记账）/ 无关事件 /
 *   无锚点入账（custom_id 缺席：不是本系统建的订单，认领面随 #181 进场）/
 *   APPROVED 但不该 capture（票不在/不在 issued/订单不认识）；
 * - 401 —— transmission 头缺失、验签不过（token/verify 失败或非 SUCCESS），
 *   零副作用；
 * - 502 —— 钱到了（capture 完成）但这边记不了：票未确认（not_issued）/ 已作废
 *   （invoice_voided）/ 找不到（invoice_not_found）/ 事件读不出可信金额 /
 *   custom_id 声明拆不开（surcharge 四种命名拒绝，billing/surcharge.ts）/
 *   APPROVED 该 capture 但 capture 调用失败。**绝不 2xx 确认记不了的钱**；
 *   502 让 PayPal 重投，等财务确认（R-12-6 人的闸门，webhook 靠重试跨过它）。
 *
 * 幂等：source = ("paypal", capture id)——重放/补发撞 payments_source_idx，
 * PaymentExistsError 被「已记账成功」语义吃掉回 200。审计与记账同事务。
 */
export function paypalWebhookRoutes(deps: { db: Db; logger: Logger; paypal: PayPalChannel | undefined }) {
  const app = new Hono<AppEnv>();

  // 方法集合显式枚举（不用 app.all）：路由普查（route-auth.test.ts）按 method
  // 逐条对册，ALL 会被当成中间件漏掉（stripe-webhook.ts 同款）。非 POST 在
  // 处理器第一行拒绝（PayPal 只投 POST）
  app.on(["POST", "GET", "PUT", "PATCH", "DELETE"], "/api/webhooks/paypal", async (c) => {
    if (c.req.method !== "POST") {
      return c.json({ error: "method_not_allowed" }, 405);
    }
    if (deps.paypal === undefined) {
      payPalMisconfigured(deps.logger, "paypal webhook");
      return c.json({ error: "misconfigured" }, 500);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await c.req.text());
    } catch {
      // 验签要吃解析后的事件（webhook_event），坏 JSON 连验签都没法做——预认证
      // 拒绝，零副作用（PayPal 自家投递恒为合法 JSON，走到这的只有探测者）
      return c.json({ error: "invalid_payload" }, 400);
    }
    const transmission: Record<keyof PayPalTransmission, string | null> = {
      authAlgo: c.req.header("paypal-auth-algo") ?? null,
      certUrl: c.req.header("paypal-cert-url") ?? null,
      transmissionId: c.req.header("paypal-transmission-id") ?? null,
      transmissionSig: c.req.header("paypal-transmission-sig") ?? null,
      transmissionTime: c.req.header("paypal-transmission-time") ?? null,
    };
    const missingHeader = (Object.keys(transmission) as (keyof PayPalTransmission)[]).find(
      (name) => transmission[name] === null,
    );
    if (missingHeader !== undefined) {
      deps.logger.warn({ header: missingHeader }, "paypal webhook transmission header missing");
      return c.json({ error: "unauthorized" }, 401);
    }
    const verdict = await deps.paypal.verifier.verify({
      transmission: transmission as {
        authAlgo: string;
        certUrl: string;
        transmissionId: string;
        transmissionSig: string;
        transmissionTime: string;
      },
      event: parsed,
    });
    if (!verdict.ok) {
      deps.logger.warn({ reason: verdict.reason }, "paypal webhook verification refused");
      return c.json({ error: "unauthorized" }, 401);
    }

    const event = normalizePayPalEvent(parsed);
    if (event.kind === "ignored") {
      deps.logger.debug("paypal webhook event ignored (no money to book)");
      return c.json({ received: true });
    }
    if (event.kind === "unparsable") {
      deps.logger.error({ reason: event.reason }, "paypal webhook paid event unparsable; asking PayPal to redeliver");
      return c.json({ error: "unparsable_event" }, 502);
    }
    if (event.kind === "capture_request") {
      return handleCaptureRequest(c, deps.paypal, event);
    }
    return handlePayment(c, event);
  });

  /** APPROVED：票在且 issued 才 capture；其余 ack 了事（钱没动，无需重投） */
  async function handleCaptureRequest(
    c: Context<AppEnv>,
    paypal: PayPalChannel,
    event: { kind: "capture_request"; orderId: string; invoiceId: string | null },
  ): Promise<Response> {
    if (event.orderId === "" || event.invoiceId === null) {
      deps.logger.warn({ orderId: event.orderId }, "paypal webhook approved order without our anchor; no capture");
      return c.json({ received: true });
    }
    const found = await deps.db
      .select({ status: schema.invoices.status })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, event.invoiceId))
      .limit(1);
    const invoice = found[0];
    const status = invoice?.status;
    if (status !== "issued") {
      // 草稿/作废/找不到：capture 会让钱落进一张记不了账的票（退款是 #240 的
      // 苦活）。订单自然过期，客户没被扣款——这是 fail-safe，不是失败
      deps.logger.warn(
        { orderId: event.orderId, invoiceId: event.invoiceId, status: status ?? "missing" },
        "paypal webhook approved order for a non-issued invoice; skipping capture",
      );
      return c.json({ received: true });
    }
    try {
      const outcome = await paypal.gateway.captureOrder(event.orderId);
      deps.logger.info(
        { orderId: event.orderId, invoiceId: event.invoiceId, outcome: outcome.outcome },
        "paypal webhook capture triggered by approved order",
      );
      // 钱的事实与 booking 都由 PAYMENT.CAPTURE.COMPLETED 承载（已经/即将到达）
      return c.json({ received: true, capture: outcome.outcome });
    } catch (err) {
      deps.logger.error({ orderId: event.orderId, err }, "paypal capture failed; asking PayPal to redeliver");
      return c.json({ error: "capture_failed" }, 502);
    }
  }

  async function handlePayment(
    c: Context<AppEnv>,
    event: Extract<NormalizedPayPalEvent, { kind: "payment" }>,
  ): Promise<Response> {
    if (event.invoiceId === null) {
      if (event.invoiceIdInvalid) {
        deps.logger.error({ externalId: event.externalId }, "paypal webhook custom_id invoice id is not a uuid; asking PayPal to redeliver");
        return c.json({ error: "unparsable_event" }, 502);
      }
      deps.logger.warn(
        { externalId: event.externalId, amountCents: event.amountCents, eventType: event.eventType },
        "paypal webhook payment without custom_id anchor; left unclaimed for #181",
      );
      return c.json({ received: true });
    }

    const invoiceId = event.invoiceId;
    try {
      const recorded = await deps.db.transaction(async (tx) => {
        const booked = await recordPayment(tx, invoiceId, {
          // amountCents = 结清额（principal）；附加费是拆分出的费成分（R-12-2/3），
          // 不参与 paid 派生——与 Stripe 渠道同一记账纪律
          amountCents: event.amountCents,
          ...(event.surchargeCents !== null ? { surchargeCents: event.surchargeCents } : {}),
          method: "paypal",
          receivedAt: event.receivedAt,
          note: `PayPal ${event.externalId}`,
          source: { type: "paypal", key: event.externalId },
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
              method: "paypal",
              paymentStatus: booked.paymentStatus,
              paidCents: booked.paidCents,
              totalCents: booked.totalCents,
              sourceType: "paypal",
              sourceKey: event.externalId,
              eventType: event.eventType,
            },
          });
        }
        return booked;
      });
      if (recorded === null) {
        deps.logger.error({ invoiceId, externalId: event.externalId }, "paypal webhook payment for unknown invoice; asking PayPal to redeliver");
        return c.json({ error: "invoice_not_found" }, 502);
      }
      deps.logger.info(
        { invoiceId, invoiceNumber: recorded.number, amountCents: event.amountCents, surchargeCents: event.surchargeCents, paymentStatus: recorded.paymentStatus, externalId: event.externalId },
        "paypal webhook payment recorded",
      );
      return c.json({ received: true, invoiceNumber: recorded.number, paymentStatus: recorded.paymentStatus });
    } catch (err) {
      if (err instanceof PaymentExistsError) {
        // 重放 / 补发：已记账成功，ack 让 PayPal 停止重投
        deps.logger.info({ externalId: event.externalId }, "paypal webhook replay for an already-recorded payment");
        return c.json({ received: true, replay: true });
      }
      if (err instanceof PaymentStateError) {
        deps.logger.warn(
          { invoiceId, externalId: event.externalId, code: err.code },
          "paypal webhook payment refused by invoice state; asking PayPal to redeliver",
        );
        return c.json({ error: err.code }, 502);
      }
      throw err;
    }
  }

  return app;
}
