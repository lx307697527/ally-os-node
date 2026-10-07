import type { Logger } from "pino";
import { z } from "zod";
import {
  PRINCIPAL_AMOUNT_METADATA_KEY,
  splitSurchargedCapture,
  SURCHARGE_AMOUNT_METADATA_KEY,
} from "./surcharge.ts";

/**
 * PayPal 收款渠道（#193）。#232 §10「Stripe / PayPal 以 webhook 为准，幂等记账
 * 并自动匹配发票」的第二条渠道；记账本体与 Stripe 完全同一个接缝——验签 +
 * 规范化后在业务事务里调 billing/payments.ts 的 recordPayment，传
 * source = ("paypal", "<capture id>")，method "paypal"（R-12-1）。
 *
 * 老系统对照 `supabase/functions/paypal-webhook`（FEAT-005 系）+ 门户
 * `lib/payment-gateway.ts`：verify-webhook-signature 活体验签在一切副作用之前、
 * fail closed 401、配置缺失答 500 misconfigured（FEAT-063：部署问题不是认证
 * 失败）、金额对账不过不入账（FEAT-581 的四条命名拒绝随 surcharge.ts 原样
 * 沿用）。本模块继承这套骨架，弃掉 Sentry/Slack 告警分流（#193 既定裁法，
 * 站内提醒随通知域进场）。
 *
 * 与 Stripe 渠道的三个结构差异（都是 PayPal 平台事实，不是设计偏好）：
 * 1. **验签是活体 API 调用，不是本地 HMAC**——PayPal 没有 Stripe 式共享密钥
 *    签名方案，防伪靠 server-to-server 的 verify-webhook-signature。因此本地
 *    没有重放窗：transmission_time 的新鲜度由 PayPal 验签端自己把守，本侧的
 *    重放防线是记账幂等（payments 唯一索引）。
 * 2. **锚点与拆分声明坐 `custom_id`**——老系统 FEAT-581 p5 的载体裁决原样带
 *    过来：capture 事件只回带 purchase_units[0].custom_id，items[] 活不到
 *    capture 上（Stripe line item 同款陷阱）；purchase_units[].invoice_id 被
 *    PayPal 按商户全局唯一校验，重试/重建单会撞 DUPLICATE_INVOICE_ID——能
 *    拒绝第二次尝试的载体不是载体。格式 `<invoiceId>`（无费）/
 *    `<invoiceId>;p=<principal 分>;s=<surcharge 分>`（有费），声明解析成
 *    Stripe metadata 的同两个键后**原样走 splitSurchargedCapture**——四种命名
 *    拒绝与 Stripe 渠道一字不差（#193 剩余清单承诺的「零改动复用」）。
 * 3. **批准不等于扣款**：PayPal 订单要商户显式 capture 钱才动。老系统在门户
 *    回跳页由服务端 capture（BUG-121）；本系统门户还没建（#186），渠道必须
 *    能独立走完真钱闭环——**webhook 驱动 capture**：收到（验签过的）
 *    CHECKOUT.ORDER.APPROVED 后按订单 custom_id 找回发票，票处于 issued 才
 *    capture；找不到/草稿/作废一律不 capture、ack 了事（订单自然过期，钱没
 *    动，不需要 502 重投一个「正确动作是什么都不做」的投递）；capture 网络失
 *    败回 502 让 PayPal 重投 APPROVED（重投窗口约 3 天，订单有效期同量级，
 *    自然收敛）。capture 成功后钱的事实仍由 PAYMENT.CAPTURE.COMPLETED 入账，
 *    与 Stripe 同一条记账路径。这也兑现 #193 要点原文「付款状态以 webhook 为
 *    准，前端结果只用于提示」——门户回跳页永远只展示，永远不 capture。
 */

/** 透明转发给网关的 fetch（测试注入假实现）；缺省 = 全局 fetch（stripe.ts 同款） */
export type Fetcher = typeof fetch;

/** PayPal REST API 基址；生产 https://api-m.paypal.com，沙箱部署注入 sandbox 域 */
export const PAYPAL_API_BASE_DEFAULT = "https://api-m.paypal.com";

// ── 金额：十进制字符串 ⇄ 整数分（全程精确整数运算） ──────────────────────────

/**
 * PayPal 金额是十进制字符串（"1500.00"）。老系统用 `Number(value) * 100` 浮点
 * 乘法，本刻意的分叉：正则拆整数/小数部做纯整数运算——"8.45" 一类二进制不可
 * 精确表示的值（8.45 × 100 = 844.999…）在这里不会产生先舍入再比较的隐患，
 * 对账等式两侧必须是同一个算术世界。0–2 位小数合法（USD 恒 2 位），其余形状
 * 一律 null（调用方映射 unparsable，502 拿不准的钱不确认）。
 */
export function payPalAmountToCents(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (match === null) return null;
  const whole = Number(match[1]);
  const frac = match[2] === undefined ? 0 : Number(match[2].padEnd(2, "0"));
  return whole * 100 + frac;
}

/** 整数分 → PayPal 金额字符串（"155850" → "1558.50"），纯整数运算无浮点 */
export function centsToPayPalAmount(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const frac = cents - whole * 100;
  return `${String(whole)}.${String(frac).padStart(2, "0")}`;
}

// ── custom_id：锚点 + 拆分声明的载体 ─────────────────────────────────────────

/**
 * 解析我们写在订单上的 custom_id。裸形式（无 `;` 段）= 无附加费订单，返回空
 * 声明——splitSurchargedCapture 的「没有 metadata 键」分支原样接管（gross 即
 * principal，回归锚点）。声明段 p=/s= 各恰一段：缺席是半申报、重复是歧义，
 * 都返回 null（老系统 declaredCents 同名拒绝）；段值是否正整数交给
 * splitSurchargedCapture 的 metadataCents（拒绝而非当零，同一实现同一纪律）。
 * 未知段键忽略（Stripe metadata 的额外键同样忽略——只读自己写的两个键）。
 */
export function parseCustomId(
  customId: string,
): { invoiceId: string; declaration: Record<string, unknown> } | null {
  const trimmed = customId.trim();
  if (trimmed === "") return null;
  const [invoiceId, ...segments] = trimmed.split(";");
  if (invoiceId === undefined || invoiceId === "") return null;
  if (segments.length === 0) {
    return { invoiceId, declaration: {} };
  }
  const declaration: Record<string, unknown> = {};
  for (const [key, metadataKey] of [
    ["p", PRINCIPAL_AMOUNT_METADATA_KEY],
    ["s", SURCHARGE_AMOUNT_METADATA_KEY],
  ] as const) {
    const matches = segments.filter((segment) => segment.startsWith(`${key}=`));
    if (matches.length !== 1) return null;
    const value = matches[0];
    if (value === undefined) return null;
    declaration[metadataKey] = value.slice(key.length + 1);
  }
  return { invoiceId, declaration };
}

// ── 事件归一 ────────────────────────────────────────────────────────────────

/** 事件信封：本切片只消费 event_type / resource；PayPal 自家的事件 id 不进幂等键 */
const payPalEventSchema = z.object({
  event_type: z.string().min(1),
  resource: z.unknown(),
});

/** PAYMENT.CAPTURE.COMPLETED 的 resource：钱的事实全在这三样（老系统同读法） */
const captureResourceSchema = z.object({
  id: z.string().min(1),
  amount: z.object({ value: z.string() }),
  custom_id: z.string().optional(),
  /** capture 时刻（ISO 8601）：记账写进 received_at 的事实时刻；缺省回退 now */
  create_time: z.string().optional(),
});

/** CHECKOUT.ORDER.APPROVED 的 resource：resource 即订单对象 */
const orderResourceSchema = z.object({
  id: z.string().min(1),
  purchase_units: z
    .array(z.object({ custom_id: z.string().optional() }))
    .min(1)
    .optional(),
});

export type NormalizedPayPalEvent =
  | {
      kind: "payment";
      /** 幂等键：capture id（银行事实的对象身份，重放/补发归一到同一行） */
      externalId: string;
      /** 结清额（principal）：surcharge 拆分后的入账金额，进 amount_cents */
      amountCents: number;
      /** 附加费成分（R-12-2/3）；null = 无附加费订单（custom_id 裸形式锚点） */
      surchargeCents: number | null;
      invoiceId: string | null;
      invoiceIdInvalid: boolean;
      receivedAt: Date;
      eventType: string;
    }
  | {
      /** 已批准的订单：路由据此决定是否服务端 capture（见文件头第 3 条） */
      kind: "capture_request";
      orderId: string;
      /** 只在 custom_id 解析成立且 invoiceId 是合法 UUID 时给出；否则 null =
       * 不是本系统建的订单（或不认识它的形状），正确动作是不 capture 并 ack */
      invoiceId: string | null;
    }
  | {
      kind: "unparsable";
      reason: string;
      /** 读得出多少算多少：站内告警的事实半边（#193 剩余③；全 null = 资源形状
       * 都读不出，无从告警）。capture id 读得出的就带上——重投的告警靠它去重 */
      externalId: string | null;
      amountCents: number | null;
      invoiceId: string | null;
    }
  | { kind: "ignored" };

/**
 * metadata 里非 UUID 的 invoice_id（stripe.ts normalizeInvoiceId 同裁）：
 * 值该是 UUID，坏值说明有人在渠道侧动过载体——CAPTURE.COMPLETED 走 502 响，
 * APPROVED 则不 capture 直接 ack（见 normalizeApprovedOrder 的注释）。
 */
function invoiceIdOf(raw: unknown): { invoiceId: string | null; invalid: boolean } {
  if (raw === undefined) {
    return { invoiceId: null, invalid: false };
  }
  if (typeof raw === "string" && z.uuid().safeParse(raw).success) {
    return { invoiceId: raw, invalid: false };
  }
  return { invoiceId: null, invalid: true };
}

/** create_time 解析 + 「不未来」收口：钟差夹到 now，不把偏差写进台账（stripe.ts 同裁） */
function receivedAtOf(createTime: string | undefined): Date {
  if (createTime === undefined) return new Date();
  const parsed = Date.parse(createTime);
  if (!Number.isFinite(parsed)) return new Date();
  return new Date(Math.min(parsed, Date.now()));
}

function normalizeCaptureCompleted(eventType: string, resource: unknown): NormalizedPayPalEvent {
  const parsed = captureResourceSchema.safeParse(resource);
  if (!parsed.success) {
    return { kind: "unparsable", reason: "capture resource shape unexpected", externalId: null, amountCents: null, invoiceId: null };
  }
  const capture = parsed.data;
  const grossCents = payPalAmountToCents(capture.amount.value);
  if (grossCents === null) {
    return { kind: "unparsable", reason: "capture event without a trustworthy decimal amount", externalId: capture.id, amountCents: null, invoiceId: null };
  }
  const customId = capture.custom_id;
  if (customId === undefined || customId.trim() === "") {
    // 钱进了我们的 PayPal 账户但没有锚点：不是本系统建的订单。没有可记账的家
    // （payments.invoice_id 非空），ack 让投递结束——认领面随 #181 进场
    return {
      kind: "payment",
      externalId: capture.id,
      amountCents: grossCents,
      surchargeCents: null,
      invoiceId: null,
      invoiceIdInvalid: false,
      receivedAt: receivedAtOf(capture.create_time),
      eventType,
    };
  }
  const carrier = parseCustomId(customId);
  if (carrier === null) {
    return { kind: "unparsable", reason: "custom_id carrier does not parse", externalId: capture.id, amountCents: grossCents, invoiceId: null };
  }
  const { invoiceId, invalid } = invoiceIdOf(carrier.invoiceId);
  // 四种命名拒绝在 splitSurchargedCapture 里（surcharge.ts 文件头）：拆不开的
  // 钱连「结清多少、费是多少」都说不清，锚不锚都一样不确认（502）
  const split = splitSurchargedCapture(grossCents, carrier.declaration);
  if (split === null) {
    return { kind: "unparsable", reason: "surcharge split does not reconcile with the amount captured", externalId: capture.id, amountCents: grossCents, invoiceId };
  }
  return {
    kind: "payment",
    externalId: capture.id,
    amountCents: split.principalCents,
    surchargeCents: split.surchargeCents,
    invoiceId,
    invoiceIdInvalid: invalid,
    receivedAt: receivedAtOf(capture.create_time),
    eventType,
  };
}

function normalizeOrderApproved(resource: unknown): NormalizedPayPalEvent {
  const parsed = orderResourceSchema.safeParse(resource);
  if (!parsed.success) {
    // 订单形状读不出：不是我们的订单，没有可 capture 的锚点。ack 不是 502——
    // 这里钱还没动，502 重投一个「正确动作是什么都不做」的投递只会空转
    return { kind: "capture_request", orderId: "", invoiceId: null };
  }
  const order = parsed.data;
  const customId = order.purchase_units?.[0]?.custom_id;
  if (customId === undefined) {
    return { kind: "capture_request", orderId: order.id, invoiceId: null };
  }
  const carrier = parseCustomId(customId);
  if (carrier === null) {
    return { kind: "capture_request", orderId: order.id, invoiceId: null };
  }
  const { invoiceId, invalid } = invoiceIdOf(carrier.invoiceId);
  if (invalid) {
    // 形状像我们的载体但 id 不是 UUID：可能在渠道侧被改过。不 capture（capture
    // 前还有发票状态门这道真闸），ack 了事——APPROVED 上没有已移动的钱可守
    return { kind: "capture_request", orderId: order.id, invoiceId: null };
  }
  return { kind: "capture_request", orderId: order.id, invoiceId };
}

/**
 * 事件归一：PAYMENT.CAPTURE.COMPLETED → payment（记账）；CHECKOUT.ORDER.APPROVED
 * → capture_request（服务端 capture 决策）；退款/撤销类（PAYMENT.CAPTURE.
 * REFUNDED / REVERSED，#240 流程）与失败类（DECLINED / DENIED，没有钱进账）
 * 显式 no-op；其余事件类型一律 ignored。
 */
export function normalizePayPalEvent(parsed: unknown): NormalizedPayPalEvent {
  const envelope = payPalEventSchema.safeParse(parsed);
  if (!envelope.success) {
    return { kind: "unparsable", reason: "event envelope shape unexpected", externalId: null, amountCents: null, invoiceId: null };
  }
  const eventType = envelope.data.event_type;
  if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
    return normalizeCaptureCompleted(eventType, envelope.data.resource);
  }
  if (eventType === "CHECKOUT.ORDER.APPROVED") {
    return normalizeOrderApproved(envelope.data.resource);
  }
  return { kind: "ignored" };
}

// ── OAuth：两条外部轨道（网关、验签）共用的 client-credentials 令牌 ────────────

const tokenResponseSchema = z.object({ access_token: z.string().min(1) });

/** 每次调用取一枚新令牌（老系统同款，webhook 体量下不值得引入过期缓存） */
async function fetchAccessToken(deps: {
  clientId: string;
  clientSecret: string;
  apiBase: string;
  fetcher: Fetcher;
}): Promise<string | null> {
  const basic = Buffer.from(`${deps.clientId}:${deps.clientSecret}`).toString("base64");
  const response = await deps.fetcher(`${deps.apiBase}/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) return null;
  const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) return null;
  return parsed.data.access_token;
}

/** 网关与验签共用的凭据组（两处同用一个 apiBase / fetcher） */
export interface PayPalCredentials {
  clientId: string;
  clientSecret: string;
  /** 缺省 PAYPAL_API_BASE_DEFAULT；沙箱部署注入 https://api-m.sandbox.paypal.com */
  apiBase?: string;
  fetcher?: Fetcher;
}

function resolvedDeps(deps: PayPalCredentials): { apiBase: string; fetcher: Fetcher } & PayPalCredentials {
  return { ...deps, apiBase: deps.apiBase ?? PAYPAL_API_BASE_DEFAULT, fetcher: deps.fetcher ?? fetch };
}

// ── 网关：订单创建 + 服务端 capture ─────────────────────────────────────────

/** checkout 订单创建输入：金额与锚点都是服务端出的，调用方给不出金额入口 */
export interface PayPalOrderInput {
  invoiceId: string;
  invoiceNumber: string;
  /** 结算额（principal）：发票行实时合计，与收款台账 amount_cents 同一语义 */
  amountCents: number;
  /** 附加费（R-12-2/3）：订单实收加收、不进发票面；缺省或 0 = 裸 custom_id */
  surchargeCents?: number;
  /** 发票行抄录的币种（当前唯一合法值 USD）；PayPal 要大写 */
  currency: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface CreatedPayPalOrder {
  id: string;
  approveUrl: string;
}

/** captureOrder 的两种终态；其余（网络/5xx）抛 PayPalGatewayError 由调用方处置 */
export type CaptureOutcome = { outcome: "completed" } | { outcome: "already_captured" };

/**
 * checkout 订单网关的域内接口：业务代码只见它，不见 PayPal REST 细节
 * （StripeGateway 同裁，AGENTS.md「依赖注入、无云厂商锁定」）。
 */
export interface PayPalGateway {
  createOrder(input: PayPalOrderInput): Promise<CreatedPayPalOrder>;
  captureOrder(orderId: string): Promise<CaptureOutcome>;
}

export class PayPalGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayPalGatewayError";
  }
}

// 订单响应里本切片消费的两个字段；rel 按 PayPal 文档 approve 优先、payer-action
// 兼容（老系统同一双候选）。第三方 API 响应按仓库规则用 zod 校验。
const orderResponseSchema = z.object({
  id: z.string().min(1),
  links: z.array(z.object({ rel: z.string(), href: z.string() })),
});

const captureErrorResponseSchema = z.object({
  details: z.array(z.looseObject({ issue: z.string().optional() })).optional(),
});

export function createPayPalGateway(deps: PayPalCredentials): PayPalGateway {
  const d = resolvedDeps(deps);
  return {
    async createOrder(input: PayPalOrderInput): Promise<CreatedPayPalOrder> {
      const token = await fetchAccessToken(d);
      if (token === null) {
        throw new PayPalGatewayError("paypal access token unavailable");
      }
      // 实扣额 = principal + 附加费；拆分声明坐 custom_id（文件头第 2 条：载体
      // 裁决与格式）。surcharge 为 0 时写裸 invoice id——与「无费订单」完全同形
      const surchargeCents = input.surchargeCents ?? 0;
      const grossCents = input.amountCents + surchargeCents;
      const response = await d.fetcher(`${d.apiBase}/v2/checkout/orders`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [
            {
              amount: { currency_code: input.currency.toUpperCase(), value: centsToPayPalAmount(grossCents) },
              custom_id:
                surchargeCents > 0
                  ? `${input.invoiceId};p=${String(input.amountCents)};s=${String(surchargeCents)}`
                  : input.invoiceId,
            },
          ],
          application_context: { return_url: input.returnUrl, cancel_url: input.cancelUrl },
        }),
      });
      if (!response.ok) {
        // 状态码进日志（服务端排障），错误细节不外传
        throw new PayPalGatewayError(`paypal order create failed with ${String(response.status)}`);
      }
      const parsed = orderResponseSchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) {
        throw new PayPalGatewayError("paypal order response shape unexpected");
      }
      const approve = parsed.data.links.find((link) => link.rel === "approve" || link.rel === "payer-action");
      if (approve === undefined || approve.href === "") {
        throw new PayPalGatewayError("paypal order has no approve link");
      }
      return { id: parsed.data.id, approveUrl: approve.href };
    },

    async captureOrder(orderId: string): Promise<CaptureOutcome> {
      const token = await fetchAccessToken(d);
      if (token === null) {
        throw new PayPalGatewayError("paypal access token unavailable");
      }
      const response = await d.fetcher(`${d.apiBase}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      });
      if (response.ok) {
        return { outcome: "completed" };
      }
      // 已捕获的订单重投 APPROVED 会走到这：不是错误，booking 由
      // PAYMENT.CAPTURE.COMPLETED 负责（或已记完），ack 即可
      if (response.status === 422) {
        const parsed = captureErrorResponseSchema.safeParse(await response.json().catch(() => undefined));
        const issues = (parsed.success ? parsed.data.details ?? [] : [])
          .map((detail) => detail.issue)
          .filter((issue): issue is string => issue !== undefined);
        if (issues.includes("ORDER_ALREADY_CAPTURED")) {
          return { outcome: "already_captured" };
        }
      }
      throw new PayPalGatewayError(`paypal order capture failed with ${String(response.status)}`);
    },
  };
}

// ── 验签：活体 verify-webhook-signature ─────────────────────────────────────

/** PayPal 投递的五根 transmission 头（老系统 TRANSMISSION_HEADERS 同清单） */
export interface PayPalTransmission {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
}

export type PayPalVerifyFailure =
  | "token_request_failed"
  | "verify_request_failed"
  | "verify_response_unexpected"
  | "verification_not_success";

export type PayPalVerifyResult = { ok: true } | { ok: false; reason: PayPalVerifyFailure };

/** 验签器的注入面：webhook 路由只见它，不见 token/verify 两跳 HTTP */
export interface PayPalWebhookVerifier {
  verify(input: { transmission: PayPalTransmission; event: unknown }): Promise<PayPalVerifyResult>;
}

const verifyResponseSchema = z.object({ verification_status: z.string() });

export function createPayPalWebhookVerifier(deps: PayPalCredentials & { webhookId: string }): PayPalWebhookVerifier {
  const d = resolvedDeps(deps);
  return {
    async verify(input: { transmission: PayPalTransmission; event: unknown }): Promise<PayPalVerifyResult> {
      const token = await fetchAccessToken(d);
      if (token === null) {
        return { ok: false, reason: "token_request_failed" };
      }
      const response = await d.fetcher(`${d.apiBase}/v1/notifications/verify-webhook-signature`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          auth_algo: input.transmission.authAlgo,
          cert_url: input.transmission.certUrl,
          transmission_id: input.transmission.transmissionId,
          transmission_sig: input.transmission.transmissionSig,
          transmission_time: input.transmission.transmissionTime,
          webhook_id: deps.webhookId,
          webhook_event: input.event,
        }),
      });
      if (!response.ok) {
        return { ok: false, reason: "verify_request_failed" };
      }
      const parsed = verifyResponseSchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) {
        // 读不出裁决 = 没有裁决：fail closed 与「非 SUCCESS」同向
        return { ok: false, reason: "verify_response_unexpected" };
      }
      if (parsed.data.verification_status !== "SUCCESS") {
        return { ok: false, reason: "verification_not_success" };
      }
      return { ok: true };
    },
  };
}

/** 渠道的注入面：AppDeps.paypal。未配置 = undefined（两端点答 500 misconfigured） */
export interface PayPalChannel {
  gateway: PayPalGateway;
  verifier: PayPalWebhookVerifier;
  /** 后台控制台对外地址（WEB_APP_URL）：审批后的回跳 URL 的地基 */
  webAppUrl: string;
}

/** 渠道未启用时的统一答案：500 misconfigured（部署问题，不是认证失败） */
export function payPalMisconfigured(logger: Logger, where: string): void {
  logger.error(
    { channel: "paypal", where },
    "paypal channel not configured (set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_WEBHOOK_ID)",
  );
}
