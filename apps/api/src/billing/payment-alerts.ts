import { eq, inArray } from "drizzle-orm";
import { schema } from "@ally/db";
import type { Db } from "@ally/db";

/**
 * 收款告警的站内投递（#193 剩余清单③：失败付款/对账拒绝的站内提醒）。
 *
 * 老系统对照：supabase/functions/stripe-webhook 的 Sentry/Slack 分流——银行借记
 * 失败（FEAT-802）、支付尝试被拒（BUG-774）、附加费拆分对不上（FEAT-581）三类
 * 告警 + Sentry fingerprint 按 externalId 去重。新系统的告警面是通知域（#116
 * 既定裁法：外部聊天分流刻意不带），去重升级为结构性：notifications.dedupe_key
 * 的部分唯一索引（0034）让 provider 对同一事实的重投最多产生一行/人，重放被
 * onConflictDoNothing 吃掉 = 「已提醒过」，与 payments 的 source 唯一索引同一
 * 「由结构保证，不靠先查后插」纪律。
 *
 * 两条告警路径（两个 webhook 共用）：
 * - **支付尝试失败**（payment.attempt_failed）：钱没动、票还欠着——老系统
 *   BUG-774 的教训是「客户说付不了」不该是唯一的发现渠道；只报带我们有效锚点的
 *   尝试（老裁决原文：only attempts that carry our invoice_id are ours）。
 * - **钱到了记不了**（payment.unbookable）：webhook 的 502 路径（票未确认/已
 *   作废/找不到/金额读不出/拆分对不上/capture 失败）。502 本身让 provider 重投
 *   等人的闸门（R-12-6），但「有笔钱在等确认」这件事必须有人知道——重投不会
 *   通知任何人，它只会重试。
 *
 * 展示面：这两种事件类型刻意**不进** web 铃铛的白名单——href parity 测试强制
 * 白名单事件有真实去处，而发票页（#192 剩余④）还没落地；payload 携带 title/
 * detail 事实走兜底面（approval.completed 的同款裁决：诚实的占位，有了承载页
 * 再进白名单）。邮件摘要的 payloadDetail 读 title/detail，自动带走。
 *
 * 收件人 = invoices.manage 持有者（owner/finance 角色默认 + user_permission
 * 个人授权，permissions.ts 的同一矩阵），去重、排序（确定性扇出）。
 */

export type PaymentAlertChannel = "stripe" | "paypal";

/** 支付尝试失败（钱没动，票还欠着） */
export const PAYMENT_ATTEMPT_FAILED_EVENT = "payment.attempt_failed";
/** 钱到了但这边记不了（provider 会重投，等人的闸门） */
export const PAYMENT_UNBOOKABLE_EVENT = "payment.unbookable";

/** 状态类拒绝的固定说明（两个渠道共用；key = 路由映射 502 的错误码） */
const STATE_REJECTION_REASONS: Record<string, string> = {
  not_issued: "the invoice is still a draft (finance has not confirmed it)",
  invoice_voided: "the invoice is void",
  invoice_not_found: "no invoice exists with that id",
  capture_failed: "the provider failed to capture the approved order",
};

/** 502 拒绝码 → 告警里的人类说明；unparsable 类的细节由归一层给出，透传兜底 */
export function unbookableReasonText(code: string, detail: string | null): string {
  return STATE_REJECTION_REASONS[code] ?? detail ?? code;
}

type AlertTx = Pick<Db, "select" | "insert">;

/** 告警的事实半边：两个字幕域共用的最小集合。文案只从这些事实拼（RULE-010）。 */
export interface PaymentAlertInput {
  eventType: typeof PAYMENT_ATTEMPT_FAILED_EVENT | typeof PAYMENT_UNBOOKABLE_EVENT;
  channel: PaymentAlertChannel;
  /** 钱的身份：payment_intent / capture id——重投去重的锚 */
  externalId: string;
  /** 机器可读的拒绝码（unbookable 的幂等键成分；attempt_failed 恒 attempt_failed） */
  reasonCode: string;
  /** 人类可读的拒绝说明（英文，一行；attempt_failed = Stripe 给的拒绝理由） */
  reason: string;
  /** 我们的有效锚点；null = 没有可认的票（attempt_failed 无锚点根本不告警） */
  invoiceId: string | null;
  /** 尝试的支付方式（attempt_failed 才有："card" / "bank account" / …） */
  method?: string;
  amountCents: number | null;
  currency: string | null;
}

/** 幂等键：同一笔钱的同一状态。reasonCode 在键里——状态演变（草稿→作废）是新事实，值得新提醒。 */
export function paymentAlertDedupeKey(input: PaymentAlertInput): string {
  return input.eventType === PAYMENT_ATTEMPT_FAILED_EVENT
    ? `pay:attempt-failed:${input.channel}:${input.externalId}`
    : `pay:unbookable:${input.channel}:${input.externalId}:${input.reasonCode}`;
}

/** 整数分 → 人类金额（1,500.00）；币种在时带 ISO 码前缀（USD 1,500.00） */
export function formatMoney(amountCents: number, currency: string | null): string {
  const negative = amountCents < 0;
  const abs = Math.abs(amountCents);
  const dollars = `${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
  return `${negative ? "-" : ""}${currency === null ? "" : `${currency.toUpperCase()} `}${dollars}`;
}

/** 发票的人类标签：有号用号，没号（票不在了）退回原始 id——老系统 Slack 同款 */
function invoiceLabelOf(invoiceId: string | null, invoiceNumber: string | null): string {
  if (invoiceNumber !== null && invoiceNumber !== "") return invoiceNumber;
  if (invoiceId !== null) return invoiceId;
  return "(unknown invoice)";
}

/** 渠道给的理由可能自带句尾句号（Stripe 的 decline message 原文）——拼句前削掉 */
function sentence(text: string): string {
  return text.trim().replace(/\.$/, "");
}

/** 铃铛/摘要共用的两个事实字段（payload.title/detail；通知域的既定读法） */
export function paymentAlertTitle(input: PaymentAlertInput, invoiceNumber: string | null): string {
  if (input.eventType === PAYMENT_ATTEMPT_FAILED_EVENT) {
    return `Payment attempt failed — invoice ${invoiceLabelOf(input.invoiceId, invoiceNumber)} is still owed`;
  }
  return `A ${input.channel} payment arrived but could not be recorded`;
}

export function paymentAlertDetail(input: PaymentAlertInput, invoiceNumber: string | null): string {
  const invoice = invoiceLabelOf(input.invoiceId, invoiceNumber);
  const money = input.amountCents === null ? null : formatMoney(input.amountCents, input.currency);
  if (input.eventType === PAYMENT_ATTEMPT_FAILED_EVENT) {
    const head = money === null
      ? `A customer's ${input.method ?? "payment"} attempt for invoice ${invoice}`
      : `A customer's ${input.method ?? "payment"} attempt of ${money} for invoice ${invoice}`;
    return `${head} did not go through: ${sentence(input.reason)}. Nothing was charged; the invoice is still owed.`;
  }
  const head = money === null
    ? `A ${input.channel} payment (ref ${input.externalId}) for invoice ${invoice}`
    : `A ${input.channel} payment of ${money} (ref ${input.externalId}) for invoice ${invoice}`;
  return `${head} arrived but could not be recorded: ${sentence(input.reason)}. The provider will keep retrying — no money is booked until this is resolved.`;
}

/** payload = 两个展示事实 + 全部结构化事实（未来白名单面/深链的原料） */
export function paymentAlertPayload(
  input: PaymentAlertInput,
  invoiceNumber: string | null,
): Record<string, unknown> {
  return {
    title: paymentAlertTitle(input, invoiceNumber),
    detail: paymentAlertDetail(input, invoiceNumber),
    channel: input.channel,
    externalId: input.externalId,
    reasonCode: input.reasonCode,
    ...(input.invoiceId !== null ? { invoiceId: input.invoiceId } : {}),
    ...(invoiceNumber !== null ? { invoiceNumber } : {}),
    ...(input.method !== undefined ? { method: input.method } : {}),
    ...(input.amountCents !== null ? { amountCents: input.amountCents } : {}),
    ...(input.currency !== null ? { currency: input.currency } : {}),
  };
}

/**
 * invoices.manage 持有者（收件人）：owner/finance 角色默认 + user_permission
 * 个人授权，去重升序（permissions.ts 的同一矩阵；effect-digest 的角色查询同款）。
 */
export async function invoiceAlertRecipients(tx: AlertTx): Promise<string[]> {
  const byRole = await tx
    .select({ id: schema.userRole.userId })
    .from(schema.userRole)
    .where(inArray(schema.userRole.role, ["owner", "finance"]));
  const byGrant = await tx
    .select({ id: schema.userPermission.userId })
    .from(schema.userPermission)
    .where(eq(schema.userPermission.permission, "invoices.manage"));
  return [...new Set([...byRole.map((row) => row.id), ...byGrant.map((row) => row.id)])].sort();
}

/**
 * 落一行/人的告警（dedupe_key 唯一索引挡重投），返回**真正拿到新行**的用户
 * （实时「催」只催新人——重投的收件人已经看过铃铛上的那条，再催一次是噪声）。
 * 没有收件人（finance/owner 都不在）= 没人可投，返回空数组不报错——与 effect
 * digest「没人收的报告是假成功」不同：这里是请求路径上的尽力面，收件人缺失是
 * 部署态不是本请求的错，502 与否由调用方的响应契约决定。
 */
export async function recordPaymentAlert(tx: AlertTx, input: PaymentAlertInput): Promise<string[]> {
  const recipients = await invoiceAlertRecipients(tx);
  if (recipients.length === 0) return [];
  let invoiceNumber: string | null = null;
  if (input.invoiceId !== null) {
    const rows = await tx
      .select({ number: schema.invoices.number })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, input.invoiceId))
      .limit(1);
    invoiceNumber = rows[0]?.number ?? null;
  }
  const inserted = await tx
    .insert(schema.notifications)
    .values(
      recipients.map((userId) => ({
        userId,
        eventType: input.eventType,
        aggregateType: input.invoiceId === null ? null : "invoice",
        aggregateId: input.invoiceId,
        payload: paymentAlertPayload(input, invoiceNumber),
        dedupeKey: paymentAlertDedupeKey(input),
      })),
    )
    // 任何冲突都只能是 (user_id, dedupe_key) 撞部分唯一索引（id 是新鲜 uuid、
    // 其余列无约束）——重投的「已提醒过」语义在这被吃掉
    .onConflictDoNothing()
    .returning({ userId: schema.notifications.userId });
  return inserted.map((row) => row.userId).sort();
}
