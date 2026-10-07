import { createHmac, timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod";
import { splitSurchargedCapture } from "./surcharge.ts";

/**
 * Stripe 收款渠道（#193）。#232 §10「Stripe / PayPal 以 webhook 为准，幂等记账
 * 并自动匹配发票」的渠道实现；记账本体在 billing/payments.ts 的 recordPayment
 * （#192 切片 2 预留的接缝：验签 + 规范化后在自己的业务事务里调它，传 source）。
 *
 * 老系统对照 `supabase/functions/stripe-webhook`（FEAT-003/005 系）：验签在解析
 * 之前、fail closed 401、配置缺失答 500 misconfigured（FEAT-063：那是部署问题，
 * 不是认证失败）、300 秒重放窗（Stripe SDK 默认值，与其他签名回调轨道同一数字）。
 * 本模块继承这套骨架，弃掉它的 Sentry/Slack 告警分流（失败付款的站内提醒随通知
 * 域进场）；surcharge 拆分以 R-12-2/3 的规则注册表裁法重做（billing/surcharge.ts，
 * 老系统 FEAT-581 的对账纪律随行）。
 *
 * 三个不变式：
 * 1. **先验签后解析**——HMAC 只对原始字节有意义，先 JSON.parse 就给了攻击者一个
 *    「改了字段再带上旧签名」的口子；
 * 2. **钱的事实只进签名覆盖的通道**——金额取事件里的 `amount_received ??
 *    amount_total`（Stripe 签过名的银行事实），全程不存在「客户端提交金额」这个
 *    入口：checkout session 的金额由服务端按发票实时合计算出（#193 验收「篡改
 *    金额被拒」在结构上成立，无字段可篡改）；
 * 3. **拿不准的钱不确认**——收到钱但票不可记（未确认/已作废/找不到）时回非
 *    2xx，让 Stripe 重投；一旦 2xx 确认，这笔钱就再也收不到了。
 */

/** 透明转发给网关的 fetch（测试注入假实现）；缺省 = 全局 fetch */
export type Fetcher = typeof fetch;

/** checkout session 创建输入：金额与币种来自服务端，调用方给不出金额入口 */
export interface CheckoutSessionInput {
  invoiceId: string;
  invoiceNumber: string;
  /** 结算额（principal）：发票行实时合计，与收款台账 amount_cents 同一语义 */
  amountCents: number;
  /** 附加费（R-12-2/3，billing/surcharge.ts）：checkout 加收、不进发票面；
   * 缺省或 0 = 无附加费的普通 session（0 与「没有」不可并存，表注释同文） */
  surchargeCents?: number;
  /** 发票行抄录的币种（当前唯一合法值 USD）；适配器转小写给 Stripe API */
  currency: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CreatedCheckoutSession {
  id: string;
  url: string;
}

/**
 * checkout session 网关的域内接口：业务代码只见它，不见 Stripe SDK / HTTP 细节
 * （Storage/Mailer 同一裁法，AGENTS.md「依赖注入、无云厂商锁定」）。生产实现走
 * Stripe REST API（fetch 注入，mailer 同款——一个调用不值得引入 SDK 依赖）。
 */
export interface StripeGateway {
  createCheckoutSession(input: CheckoutSessionInput): Promise<CreatedCheckoutSession>;
}

const STRIPE_CHECKOUT_SESSIONS_URL = "https://api.stripe.com/v1/checkout/sessions";

// 2xx 响应体里本切片消费的两个字段；其余（payment_status、expires_at…）不依赖。
// 第三方 API 响应按仓库规则用 zod 校验——形状不对等于没建成，调用方需要知道。
const checkoutSessionResponseSchema = z.object({ id: z.string().min(1), url: z.string().min(1) });

export class StripeGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeGatewayError";
  }
}

/** 表单编码 Stripe API 参数（嵌套用方括号约定：line_items[0][price_data][…]） */
function encodeForm(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

export function createStripeGateway(deps: { secretKey: string; fetcher?: Fetcher }): StripeGateway {
  const fetcher = deps.fetcher ?? fetch;
  return {
    async createCheckoutSession(input: CheckoutSessionInput): Promise<CreatedCheckoutSession> {
      // 实扣额 = principal + 附加费；拆分搭 metadata 回来——事件里只有一个总数，
      // webhook 端的对账全靠这两个键（billing/surcharge.ts 文件头）。surcharge
      // 为 0 时不写拆分键：session 与「本切片上线前」的存量会话完全同形
      const surchargeCents = input.surchargeCents ?? 0;
      const response = await fetcher(STRIPE_CHECKOUT_SESSIONS_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${deps.secretKey}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: encodeForm({
          mode: "payment",
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          client_reference_id: input.invoiceId,
          "metadata[invoice_id]": input.invoiceId,
          "metadata[invoice_number]": input.invoiceNumber,
          ...(surchargeCents > 0
            ? {
                "metadata[principal_amount_cents]": String(input.amountCents),
                "metadata[surcharge_amount_cents]": String(surchargeCents),
              }
            : {}),
          "line_items[0][quantity]": "1",
          "line_items[0][price_data][currency]": input.currency.toLowerCase(),
          "line_items[0][price_data][unit_amount]": String(input.amountCents + surchargeCents),
          "line_items[0][price_data][product_data][name]": `Invoice ${input.invoiceNumber}`,
        }),
      });
      if (!response.ok) {
        // 状态码进日志（服务端排障），错误细节不外传——调用方拿到统一的网关错误
        throw new StripeGatewayError(`stripe checkout session create failed with ${String(response.status)}`);
      }
      const parsed = checkoutSessionResponseSchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) {
        throw new StripeGatewayError("stripe checkout session response shape unexpected");
      }
      return parsed.data;
    },
  };
}

/** 渠道的注入面：AppDeps.stripe。未配置 = undefined（两端点答 500 misconfigured） */
export interface StripeChannel {
  gateway: StripeGateway;
  webhookSecret: string;
  /** 后台控制台对外地址（WEB_APP_URL）：checkout 成功/取消回跳 URL 的地基 */
  webAppUrl: string;
}

// ── webhook 验签 ─────────────────────────────────────────────────────────────

/**
 * 签名时间戳允许多「旧」。300 秒 = Stripe SDK 默认重放窗，也是老系统与其他签名
 * 回调轨道的同一数字——没有人需要记住一个每家不同的数。
 */
export const STRIPE_REPLAY_WINDOW_SECONDS = 300;

export type StripeSignatureFailure =
  | "missing_header"
  | "malformed_header"
  | "stale_timestamp"
  | "bad_signature";

export type StripeSignatureResult = { ok: true } | { ok: false; reason: StripeSignatureFailure };

/** Lowercase hex of HMAC-SHA256 over `${timestamp}.${rawBody}`, keyed by secret. */
function signedPayloadHex(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/** Constant-time compare of two hex digests; unequal length never matches. */
function hexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * 验签为什么不够、还要查时间戳：HMAC 证明字节来自 Stripe，不证明「现在」。
 * `t` 在签名覆盖的载荷里，重放者造不出新 t——但他不需要：把捕获到的请求原样
 * 重放，旧 t 也完美验签。唯一能拒绝它的是拿 t 对表。
 *
 * 时间窗的比较用正向提问（`<= window`）而不是 `> window` 拒绝：垃圾 t 是 NaN，
 * `NaN > 300` 为 false 会读成「不陈旧」放行；`NaN <= 300` 为 false 正确读成
 * 「不新鲜」（RULE-002 fail closed 的方向）。两个方向都出窗都拒绝——未来远处
 * 的 t 不是投递，放行等于存下一张作者想多久有效就多久有效的签名。
 */
export function stripeTimestampIsFresh(timestamp: string, nowSeconds: number): boolean {
  const signedAt = Number(timestamp);
  if (!Number.isFinite(signedAt)) return false;
  return Math.abs(nowSeconds - signedAt) <= STRIPE_REPLAY_WINDOW_SECONDS;
}

/** Parse `Stripe-Signature: t=<ts>,v1=<hex>[,v1=<hex>...]` into t + every v1. */
function parseStripeSignature(header: string): { t: string | null; v1: string[] } {
  let t: string | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") t = value;
    else if (key === "v1" && value !== "") v1.push(value);
  }
  return { t, v1 };
}

/**
 * 对原始字节验签（Stripe-Signature: HMAC-SHA256 hex，密钥原样作 UTF-8 key）。
 * Stripe 可能带多个 v1 候选（密钥轮换），任一命中即通过。拒绝只给 reason，
 * 不带细节——401 的语义对探测者应当一视同仁。
 */
export function verifyStripeSignature(input: {
  secret: string;
  header: string | undefined;
  rawBody: string;
  nowSeconds: number;
}): StripeSignatureResult {
  if (input.header === undefined || input.header.trim() === "") {
    return { ok: false, reason: "missing_header" };
  }
  const { t, v1 } = parseStripeSignature(input.header);
  if (t === null || v1.length === 0) {
    return { ok: false, reason: "malformed_header" };
  }
  if (!stripeTimestampIsFresh(t, input.nowSeconds)) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const expected = signedPayloadHex(input.secret, t, input.rawBody);
  for (const candidate of v1) {
    if (hexEquals(candidate.toLowerCase(), expected)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "bad_signature" };
}

// ── 事件解析与归一 ───────────────────────────────────────────────────────────

// 三个「钱已到手」的事件：卡支付 completed 即到账；银行借记 async_payment_succeeded
// 才是结算（completed 时可能 still unpaid——照搬老系统 FEAT-802 的事件清单）。
// payment_intent.succeeded 与前者对同一笔钱会各发一次：externalId 取
// payment_intent ?? id，两者归一到同一个 source key，第二发是幂等重放。
const PAID_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "payment_intent.succeeded",
]);

/** Stripe 事件信封：本切片只消费 id/type/created/data.object；其余字段忽略 */
const stripeEventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  /** 事件时刻（unix 秒）：钱到账的事实时刻，记账时写进 received_at */
  created: z.number().int().nonnegative(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});

export type StripeEvent = z.infer<typeof stripeEventSchema>;

/** 归一结果：payment = 有钱可记；payment_failed = 支付尝试失败（钱没动，#193
 * 告警切片开始消费）；ignored = 与记账无关（退款类 refund.* 仍显式 no-op，
 * #240 的流程）；unparsable = 是钱的事件但读不出可信的账——金额读不出、或
 * surcharge 拆分对不上（拿不准的钱不确认，502 让 Stripe 重投）。unparsable
 * 尽可能携带可读出的事实（外部 id/金额/锚点）：这些事实喂给站内告警，让财务
 * 知道「有笔钱在等处理」——事件读不出账不等于事件不存在。 */
export type NormalizedStripeEvent =
  | {
      kind: "payment";
      /** 幂等键：payment_intent 优先，缺省回退事件对象自身 id（银行借记场景） */
      externalId: string;
      /** 结清额（principal）：surcharge 拆分后的入账金额，进收款台账 amount_cents */
      amountCents: number;
      /** 附加费成分（R-12-2/3）；null = 无附加费 session（回归锚点：拆分键缺席） */
      surchargeCents: number | null;
      /** 我们创建的 session 才带 metadata.invoice_id；缺 = 不是发票支付（无锚点） */
      invoiceId: string | null;
      invoiceIdInvalid: boolean;
      /** 事件对象的币种（小写 ISO）；缺 = 事件没带——只进告警文案，记账不读它 */
      currency: string | null;
      receivedAt: Date;
      eventType: string;
    }
  | {
      kind: "payment_failed";
      /** 幂等键：payment_intent ?? 对象 id——同一笔尝试的重发归一到同一把告警键 */
      externalId: string;
      /** 我们的有效锚点；null = 不是本系统的尝试（不告警，ack 了事——老裁决） */
      invoiceId: string | null;
      invoiceIdInvalid: boolean;
      /** "card" / "bank account" / 渠道原词 / "unknown method"（老系统同款读法） */
      method: string;
      /** Stripe 给的拒绝理由（code — decline_code — message，削到定长） */
      reason: string;
      amountCents: number | null;
      currency: string | null;
      occurredAt: Date;
      eventType: string;
    }
  | {
      kind: "unparsable";
      reason: string;
      /** 读得出多少算多少：告警的事实半边（全 null = 信封形状都读不出，无从告警） */
      externalId: string | null;
      grossCents: number | null;
      currency: string | null;
      invoiceId: string | null;
    }
  | { kind: "ignored" };

/**
 * metadata 里非 UUID 的 invoice_id：session 是我们建的、值该是 UUID——坏值说明
 * 有人在 Stripe 侧动了元数据。与「metadata 缺席」（第三方/手工 session，200 ack
 * 让 #181 的认领面接手）分开：present-but-invalid 走 unparsable（502，响声大）。
 */
function normalizeInvoiceId(metadata: Record<string, unknown>): { invoiceId: string | null; invalid: boolean } {
  const raw = metadata.invoice_id;
  if (raw === undefined) {
    return { invoiceId: null, invalid: false };
  }
  if (typeof raw === "string" && z.uuid().safeParse(raw).success) {
    return { invoiceId: raw, invalid: false };
  }
  return { invoiceId: null, invalid: true };
}

/**
 * 金额读法：`amount_received ?? amount_total`——received 是银行事实，total 是
 * session 意向；卡支付两者相等，异步借记结算时只有 received 可信。都缺或非负
 * 整数校验不过 = 读不出可信金额（unparsable，502）。读到的是**总额（gross）**，
 * surcharge 拆分在下一步。
 */
function normalizeAmountCents(object: Record<string, unknown>): number | null {
  const candidates = [object.amount_received, object.amount_total];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return null;
}

function normalizeMetadata(object: Record<string, unknown>): Record<string, unknown> {
  return typeof object.metadata === "object" && object.metadata !== null
    ? (object.metadata as Record<string, unknown>)
    : {};
}

function normalizeCurrency(object: Record<string, unknown>): string | null {
  return typeof object.currency === "string" && object.currency !== "" ? object.currency : null;
}

/** externalId = payment_intent ?? object.id（事件对象自身：cs_… / pi_…）。信封的
 * event.id 不行——同一笔钱会发多个事件（completed + succeeded），幂等键必须在
 * 对象上，重放才归一到同一行 */
function normalizeExternalId(object: Record<string, unknown>): string | null {
  const intentCandidate = object.payment_intent;
  const objectCandidate = object.id;
  return typeof intentCandidate === "string" && intentCandidate !== ""
    ? intentCandidate
    : typeof objectCandidate === "string" && objectCandidate !== ""
      ? objectCandidate
      : null;
}

// ── 失败尝试的事实读法（payment_failed；老系统 paymentMethodLabel/
// paymentRefusalReason 的移植，BUG-774 的告警面）────────────────────────────

/** "bank account" / "card" / 渠道原词——职员嘴里的轨道名（老系统同款映射） */
function paymentMethodLabel(object: Record<string, unknown>): string {
  const error = object.last_payment_error;
  const errorRecord = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const paymentMethod = errorRecord.payment_method;
  const methodRecord =
    typeof paymentMethod === "object" && paymentMethod !== null ? (paymentMethod as Record<string, unknown>) : {};
  const fromError = methodRecord.type;
  const types = object.payment_method_types;
  const fromSession = Array.isArray(types) && typeof types[0] === "string" ? types[0] : "";
  const type = typeof fromError === "string" && fromError !== "" ? fromError : fromSession;
  if (type === "us_bank_account") return "bank account";
  if (type === "card") return "card";
  return type === "" ? "unknown method" : type;
}

/** Stripe 自己的拒绝词：`code — decline_code — message`，有啥读啥（老系统同款）。
 * 定长收口：告警 payload 不是 Stripe 的日志归档，500 字符装得下任何人话理由。 */
const PAYMENT_FAILURE_REASON_MAX_LENGTH = 500;

function paymentRefusalReason(object: Record<string, unknown>): string {
  const error = object.last_payment_error;
  const errorRecord = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const parts = [errorRecord.code, errorRecord.decline_code, errorRecord.message].filter(
    (part): part is string => typeof part === "string" && part.trim() !== "",
  );
  const reason = parts.length > 0 ? parts.join(" — ") : "Stripe gave no reason";
  return reason.length > PAYMENT_FAILURE_REASON_MAX_LENGTH
    ? `${reason.slice(0, PAYMENT_FAILURE_REASON_MAX_LENGTH)}…`
    : reason;
}

/** 失败尝试的金额：pi 对象带 amount；session 对象带 amount_total。读不出 = null */
function attemptAmountCents(object: Record<string, unknown>): number | null {
  const candidates = [object.amount, object.amount_total];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return null;
}

// 老系统 FEAT-802/BUG-774 的两个失败事件：银行借记提交后被银行打回（票还欠着）
// 与支付尝试被拒/被风控拦下（分文未扣）。带我们锚点的才报（老裁决原文：
// only attempts that carry our invoice_id are ours to report）。
const FAILED_ATTEMPT_EVENT_TYPES = new Set([
  "checkout.session.async_payment_failed",
  "payment_intent.payment_failed",
]);

export function normalizeStripeEvent(parsed: unknown): NormalizedStripeEvent {
  const envelope = stripeEventSchema.safeParse(parsed);
  if (!envelope.success) {
    return { kind: "unparsable", reason: "event envelope shape unexpected", externalId: null, grossCents: null, currency: null, invoiceId: null };
  }
  const event = envelope.data;
  const object = event.data.object;
  if (FAILED_ATTEMPT_EVENT_TYPES.has(event.type)) {
    const metadata = normalizeMetadata(object);
    const { invoiceId, invalid } = normalizeInvoiceId(metadata);
    return {
      kind: "payment_failed",
      externalId: normalizeExternalId(object) ?? event.id,
      // 有钱没动的事件没有「读不出外部 id」的死路：真读不出（形状被渠道侧动过）
      // 退回信封 id——告警键仍然稳定，重投照样归一
      invoiceId,
      invoiceIdInvalid: invalid,
      method: paymentMethodLabel(object),
      reason: paymentRefusalReason(object),
      amountCents: attemptAmountCents(object),
      currency: normalizeCurrency(object),
      occurredAt: new Date(Math.min(event.created * 1000, Date.now())),
      eventType: event.type,
    };
  }
  if (!PAID_EVENT_TYPES.has(event.type)) {
    // 退款类（refund.*，#240 的流程）显式 no-op：没有钱进账，不该拦下投递
    return { kind: "ignored" };
  }
  const metadata = normalizeMetadata(object);
  const externalId = normalizeExternalId(object);
  const currency = normalizeCurrency(object);
  const grossCents = normalizeAmountCents(object);
  if (grossCents === null) {
    return { kind: "unparsable", reason: "paid event without a trustworthy integer amount", externalId, grossCents: null, currency, invoiceId: null };
  }
  if (externalId === null) {
    return { kind: "unparsable", reason: "paid event without an external id", externalId: null, grossCents, currency, invoiceId: null };
  }
  const { invoiceId, invalid } = normalizeInvoiceId(metadata);
  // surcharge 对账（billing/surcharge.ts 四种命名拒绝）：拆不开的钱连「结清多少、
  // 费是多少」都说不清，锚不锚都一样不确认——无锚点 + 拆分成立时才走「留认领」
  const split = splitSurchargedCapture(grossCents, metadata);
  if (split === null) {
    return { kind: "unparsable", reason: "surcharge split does not reconcile with the amount received", externalId, grossCents, currency, invoiceId };
  }
  // received_at 的「不未来」不变式在这里收口：Stripe 与本机的钟差（未来的事件
  // 时刻）夹到 now，不把偏差写进台账
  const receivedAt = new Date(Math.min(event.created * 1000, Date.now()));
  return {
    kind: "payment",
    externalId,
    amountCents: split.principalCents,
    surchargeCents: split.surchargeCents,
    invoiceId,
    invoiceIdInvalid: invalid,
    currency,
    receivedAt,
    eventType: event.type,
  };
}

/** 渠道未启用时的统一答案：500 misconfigured（部署问题，不是认证失败） */
export function stripeMisconfigured(logger: Logger, where: string): void {
  logger.error({ channel: "stripe", where }, "stripe channel not configured (set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET)");
}
