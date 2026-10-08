import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import { effectiveDueCents, sumCreditCents } from "./credits.ts";
import { sumLineTotals } from "./service.ts";

/**
 * 收款台账服务（#192 切片 2：收款与 paid 态）。
 *
 * 设计依据 #232 §10「Stripe / PayPal 以 webhook 为准，幂等记账并自动匹配发票」。
 * 老系统对照 billing.payments + record_payment_atomic（20260724181634）：到账推进
 * invoice_status 快照。本服务的两个核心裁决（与老系统的刻意差异，表注释同文）：
 *
 * - **付款态派生，不落列**：computePaymentStatus(total, paid) 是唯一权威定义，
 *   消费方（#241 发货门槛、财务待收视图、#181 QuickBooks）都从这里读——快照
 *   列的老 bug554 家族在「两个输入各自结构性无漂移」的前提下没有存在空间。
 *   门槛跨越的「事实」由 payment.recorded 审计的 paymentStatus 携带。
 * - **到账不推进发票状态**：财务确认（R-12-6）是人的闸门。draft/void 票记账
 *   fail closed（PaymentStateError），webhook 层（#193）把错误映射给 provider
 *   的重试机制——老系统「未知发票返回 NULL」同一去向，只是多分了两种可读码。
 *
 * **webhook 接缝**：#193 验签 + 规范化后在自己的业务事务里调 recordPayment，
 * 传 source（如 ("stripe", "<event_id>")）；PaymentExistsError 对 webhook 语义
 * 是「重放，已记账成功」（吃掉异常回 2xx），对 HTTP 面映射 409。手工记账
 * （财务在后台录电汇到账）不传 source，无幂等键——同一笔电汇录两次是两个
 * 事实行，财务自己删错行（void）。
 *
 * 锁纪律：所有动词先锁发票行再动钱——recordPayment / voidPayment 对同一张票
 * 串行，审计里的 paymentStatus（记账后的实时 SUM）因此是精确值，不依赖
 * 隔离级别的善意。
 */

/** 付款方式词表（pgEnum payment_method 同款）；R-12-1 不收支票 */
export const PAYMENT_METHODS = ["card", "paypal", "wire_ach"] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** 发票的付款态：派生值（见文件头），paid 含超收（多收的钱是事实，退款走 #240） */
export type InvoicePaymentStatus = "unpaid" | "partial" | "paid";

/**
 * 付款态的唯一权威定义。total = 0（全零价行）没有可收的钱 → paid
 * （ vacuously settled——财务不该追一张 $0 的票）。
 */
export function computePaymentStatus(totalCents: number, paidCents: number): InvoicePaymentStatus {
  if (paidCents >= totalCents) return "paid";
  if (paidCents > 0) return "partial";
  return "unpaid";
}

/** 记账输入：金额整数分、方式词表、到账时刻（缺省 = 记账时刻）；source 幂等键。
 * amountCents 恒为结清额（principal，R-12-2/3 的发票面不变裁决）；附加费走
 * surchargeCents（> 0 整数分，webhook 拆分对账后的费成分；手工记账不收费） */
export interface RecordPaymentInput {
  amountCents: number;
  method: PaymentMethod;
  receivedAt: Date;
  note: string | null;
  source?: { type: string; key: string };
  surchargeCents?: number;
  recordedById: string | null;
}

/** webhook 重放 / 手工重复 source：HTTP 面 409，webhook 面当成功（见文件头） */
export class PaymentExistsError extends Error {
  readonly code = "payment_exists";
  constructor(source: { type: string; key: string }) {
    super(`payment: already recorded for source "${source.type}:${source.key}"`);
    this.name = "PaymentExistsError";
  }
}

/** 状态不允许记账/该收款行不可再动；code 由路由映射 409 */
export class PaymentStateError extends Error {
  readonly code: "not_issued" | "invoice_voided" | "payment_voided";
  constructor(code: "not_issued" | "invoice_voided" | "payment_voided") {
    super(`payment: action not allowed in current state (${code})`);
    this.name = "PaymentStateError";
    this.code = code;
  }
}

/** 事务句柄（billing/service.ts InvoiceTx 同款）：属主域传自己的事务 */
export type PaymentTx = Pick<Db, "select" | "insert" | "update" | "delete">;

export interface InvoicePaymentSummary {
  totalCents: number;
  /** 有效贷项合计（未 void 贷项单实时 SUM，#192 红冲切片）；应付口径见 summarizeInvoicePayments */
  creditedCents: number;
  paidCents: number;
  paymentStatus: InvoicePaymentStatus;
}

/**
 * 记一笔款（手工记账与 #193 webhook 同一条路径）。
 *
 * 锁发票行 → 状态门（只对 issued 记账）→ 插入（source 唯一索引兜幂等）→
 * 同事务实时 SUM 出记账后的付款态。票不存在返回 null（路由 404）。currency
 * 从发票行抄录，调用方给不了也不需要给。
 */
export async function recordPayment(
  tx: PaymentTx,
  invoiceId: string,
  input: RecordPaymentInput,
  options: { now?: Date } = {},
): Promise<{ id: string; number: string } & InvoicePaymentSummary | null> {
  const locked = await tx
    .select({ number: schema.invoices.number, status: schema.invoices.status, currency: schema.invoices.currency })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId))
    .for("update")
    .limit(1);
  const invoice = locked[0];
  if (invoice === undefined) {
    return null;
  }
  if (invoice.status === "void") {
    throw new PaymentStateError("invoice_voided");
  }
  if (invoice.status !== "issued") {
    throw new PaymentStateError("not_issued");
  }
  let inserted: { id: string }[];
  try {
    inserted = await tx
      .insert(schema.payments)
      .values({
        invoiceId,
        method: input.method,
        amountCents: input.amountCents,
        surchargeCents: input.surchargeCents ?? null,
        currency: invoice.currency,
        sourceType: input.source?.type ?? null,
        sourceKey: input.source?.key ?? null,
        receivedAt: input.receivedAt,
        note: input.note,
        recordedById: input.recordedById,
        createdAt: options.now ?? new Date(),
      })
      .returning({ id: schema.payments.id });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new PaymentExistsError(input.source ?? { type: "unknown", key: "unknown" });
    }
    throw err;
  }
  const row = inserted[0];
  if (row === undefined) {
    throw new Error("payment record: insert returned no row");
  }
  const summary = await summarizeInvoicePayments(tx, invoiceId);
  return { id: row.id, number: invoice.number, ...summary };
}

/**
 * 作废一笔误录（更正动词：钱行不 DELETE，void 后 SUM 剔除、审计留痕）。
 * 重复作废幂等返回 already（no-op 不写审计）；退款是 #240 的流程，不在这。
 * 付款行不存在返回 null（路由 404）。
 */
export async function voidPayment(
  tx: PaymentTx,
  paymentId: string,
  actorId: string,
  reason: string,
  options: { now?: Date } = {},
): Promise<
  | {
      outcome: "voided" | "already";
      invoiceId: string;
      number: string;
      amountCents: number;
      method: string;
    } & InvoicePaymentSummary
  | null
> {
  const now = options.now ?? new Date();
  const found = await tx
    .select({
      id: schema.payments.id,
      invoiceId: schema.payments.invoiceId,
      amountCents: schema.payments.amountCents,
      method: schema.payments.method,
      voidedAt: schema.payments.voidedAt,
    })
    .from(schema.payments)
    .where(eq(schema.payments.id, paymentId))
    .limit(1);
  const payment = found[0];
  if (payment === undefined) {
    return null;
  }
  // 与 recordPayment 同序（先票后钱）——两个动词对同一张票串行，SUM 不撕裂
  const locked = await tx
    .select({ number: schema.invoices.number })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, payment.invoiceId))
    .for("update")
    .limit(1);
  const invoice = locked[0];
  if (invoice === undefined) {
    throw new Error(`payment void: invoice ${payment.invoiceId} missing for payment ${payment.id}`);
  }
  // 票锁拿到后再锁钱行复查——并发的两个 void 在这里排队，后到者看见已 void
  const lockedPayment = await tx
    .select({ voidedAt: schema.payments.voidedAt })
    .from(schema.payments)
    .where(eq(schema.payments.id, paymentId))
    .for("update")
    .limit(1);
  if (lockedPayment[0]?.voidedAt !== null && lockedPayment[0]?.voidedAt !== undefined) {
    const summary = await summarizeInvoicePayments(tx, payment.invoiceId);
    return {
      outcome: "already",
      invoiceId: payment.invoiceId,
      number: invoice.number,
      amountCents: payment.amountCents,
      method: payment.method,
      ...summary,
    };
  }
  await tx
    .update(schema.payments)
    .set({ voidedAt: now, voidedById: actorId, voidReason: reason })
    .where(eq(schema.payments.id, paymentId));
  const summary = await summarizeInvoicePayments(tx, payment.invoiceId);
  return {
    outcome: "voided",
    invoiceId: payment.invoiceId,
    number: invoice.number,
    amountCents: payment.amountCents,
    method: payment.method,
    ...summary,
  };
}

/** 有效收款合计 = 未 void 行的实时 SUM（void 剔除，见 voidPayment） */
export async function sumPaidCents(tx: Pick<Db, "select">, invoiceId: string): Promise<number> {
  const rows = await tx
    .select({ paid: sql<string>`coalesce(sum(${schema.payments.amountCents}), 0)` })
    .from(schema.payments)
    .where(and(eq(schema.payments.invoiceId, invoiceId), isNull(schema.payments.voidedAt)));
  return Number(rows[0]?.paid ?? 0);
}

/**
 * 发票的付款态三件套（#192 红冲切片起为四件套）：实时合计 + 派生态（读写面
 * 共用的一个定义）。paymentStatus 的应付口径是**有效应付**（发票合计 − 有效
 * 贷项，credits.ts 的唯一权威算术）——贷项单确认后发票就算「欠得少了」，$0
 * 有效应付的票 vacuously paid（全冲抵的票不该再挨催）。
 */
export async function summarizeInvoicePayments(
  tx: Pick<Db, "select">,
  invoiceId: string,
): Promise<InvoicePaymentSummary> {
  const totalCents = await sumLineTotals(tx, invoiceId);
  const creditedCents = await sumCreditCents(tx, invoiceId);
  const paidCents = await sumPaidCents(tx, invoiceId);
  return {
    totalCents,
    creditedCents,
    paidCents,
    paymentStatus: computePaymentStatus(effectiveDueCents(totalCents, creditedCents), paidCents),
  };
}

/** 一张票的收款台账读法；票不存在返回 null（路由 404） */
export async function listPaymentsForInvoice(
  tx: Pick<Db, "select">,
  invoiceId: string,
): Promise<
  | (InvoicePaymentSummary & {
      payments: {
        id: string;
        method: string;
        amountCents: number;
        surchargeCents: number | null;
        currency: string;
        receivedAt: Date;
        note: string | null;
        voidedAt: Date | null;
        voidReason: string | null;
        createdAt: Date;
      }[];
    })
  | null
> {
  const found = await tx
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId))
    .limit(1);
  if (found[0] === undefined) {
    return null;
  }
  const rows = await tx
    .select({
      id: schema.payments.id,
      method: schema.payments.method,
      amountCents: schema.payments.amountCents,
      surchargeCents: schema.payments.surchargeCents,
      currency: schema.payments.currency,
      receivedAt: schema.payments.receivedAt,
      note: schema.payments.note,
      voidedAt: schema.payments.voidedAt,
      voidReason: schema.payments.voidReason,
      createdAt: schema.payments.createdAt,
    })
    .from(schema.payments)
    .where(eq(schema.payments.invoiceId, invoiceId))
    .orderBy(schema.payments.createdAt);
  const summary = await summarizeInvoicePayments(tx, invoiceId);
  return { ...summary, payments: rows };
}

/** pg 唯一约束冲突（23505）：沿 DrizzleQueryError 因果链找码（billing/service.ts 同款） */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "23505") return true;
    current = candidate.cause;
  }
  return false;
}
