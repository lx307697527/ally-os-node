import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import {
  type InvoiceSubject,
  type InvoiceTx,
  createDraftInvoice,
} from "./service.ts";
import { computePaymentStatus } from "./payments.ts";
import { effectiveDueCents } from "./credits.ts";

/**
 * 分期拆票服务（#192 分期切片：一个约定总额切成 n 张草稿票）。
 *
 * 设计依据 #232 §10「分期、更正、贷项」。更正/贷项已随红冲切片落地（一张新
 * 单据冲抵已发出的票）；分期是另一半：客户按约定分几期支付时，财务一次把
 * 总额切成 n 张 `installment` 类型的草稿票——每期一张、各自走发票的既有动词
 * （confirm 的账期 R-12-7、收款、void），分期不引入第二套单据状态机。
 * 老系统对照（#88 手工时代）：分期散在母子票 parent_invoice_id 接缝与屏幕
 * 推导里——「Part i of n」从当前页行集算出来，三期计划印成 "Part 1 of 1"
 * （BUG-274），计划总额没有权威落点。本服务的答案：
 *
 * - **计划是事实，票是文档**：invoice_plans.total_cents 是创建事务里盖章的
 *   约定拆分额（= 各期之和，之后恒不变）；成员票是普通发票，草稿可改行、
 *   可 void——「约定 vs 现状」的差由计划读面作为 uninvoicedCents 原样暴露
 *   （可以为负，不 clamp：现状超过约定是必须看得见的事实）。
 * - **序数是身份，计数是现状**：plan_index 在创建事务里按提交顺序落定，
 *   永不重编号；n（成员数，含 void）读时 COUNT 派生。老系统 BUG-274 的教训
 *   反过来用——序数绝不能从读到的行集推导。
 * - **无 source 幂等列**：当前唯一入口是财务手工拆票（HTTP 面）；订单域
 *   （#231）按比例拆期进场时调本文件的 createInvoicePlan（事务句柄同款，
 *   届时 expand 唯一索引，贷项单同裁）。
 *
 * 原子性：计划行 + n 张票 + n 次发号在**同一个事务**里生灭——第 3 期发号
 * 失败（NoActiveRuleError）则整个计划从未存在。成员间无锁竞争（互不引用），
 * 不需要行锁。
 */

/** 一期的拆分下限：拆一张一期的票不是分期（手工建票已有那个入口） */
export const PLAN_PARTS_MIN = 2;

/** 一期数量的护栏：月付一年的量级；再长是融资安排，不是发票拆分 */
export const PLAN_PARTS_MAX = 12;

export interface CreateInvoicePlanInput {
  label: string;
  subject?: InvoiceSubject;
  parts: { amountCents: number }[];
  createdById: string;
}

export interface CreatedPart {
  id: string;
  number: string;
  planIndex: number;
  amountCents: number;
}

export interface CreateInvoicePlanResult {
  id: string;
  label: string;
  totalCents: number;
  currency: string;
  parts: CreatedPart[];
}

/**
 * 创建计划 + n 张分期草稿票（同一事务）。
 *
 * 每期是一张单行的票（description = 「<label> — installment i of n」，
 * quantity 1、单价 = 该期金额；行合计生成列即该期金额，无二次算术）。
 * 币种落在计划行上，成员票从计划抄录（贷项单从原票抄录同裁）。
 * totalCents 由各期之和在此盖章（调用方无需传，也传不进——约定额是切出来的
 * 结果，不是谁另报的数）。
 */
export async function createInvoicePlan(
  tx: InvoiceTx,
  input: CreateInvoicePlanInput,
  options: { now?: Date } = {},
): Promise<CreateInvoicePlanResult> {
  const now = options.now ?? new Date();
  const totalCents = input.parts.reduce((sum, part) => sum + part.amountCents, 0);
  const inserted = await tx
    .insert(schema.invoicePlans)
    .values({
      label: input.label,
      subjectType: input.subject?.type ?? null,
      subjectId: input.subject?.id ?? null,
      totalCents,
      createdById: input.createdById,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.invoicePlans.id });
  const plan = inserted[0];
  if (plan === undefined) {
    throw new Error("invoice plan create: insert returned no row");
  }
  const partCount = input.parts.length;
  const parts: CreatedPart[] = [];
  for (const [index, part] of input.parts.entries()) {
    const planIndex = index + 1;
    const created = await createDraftInvoice(
      tx,
      {
        invoiceType: "installment",
        lines: [
          {
            description: `${input.label} — installment ${planIndex} of ${partCount}`,
            quantity: 1,
            unitPriceCents: part.amountCents,
          },
        ],
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        plan: { id: plan.id, index: planIndex },
        createdById: input.createdById,
      },
      { now },
    );
    parts.push({
      id: created.id,
      number: created.number,
      planIndex,
      amountCents: part.amountCents,
    });
  }
  return { id: plan.id, label: input.label, totalCents, currency: "USD", parts };
}

// ---- 计划读面 ----

export interface PlanPart {
  invoiceId: string;
  number: string;
  planIndex: number;
  status: "draft" | "issued" | "void";
  totalCents: number;
  creditedCents: number;
  paidCents: number;
  paymentStatus: "unpaid" | "partial" | "paid";
}

export interface InvoicePlanRead {
  id: string;
  label: string;
  subject: InvoiceSubject | null;
  currency: string;
  totalCents: number;
  createdAt: Date;
  /** 成员数（含 void）——「Part i of n」的 n，成员关系的现状 */
  partCount: number;
  /** 在世（未 void）成员数 */
  livePartCount: number;
  /** 在世成员的行合计之和（void 的期回到「未拆」一侧） */
  liveInvoicedCents: number;
  /** 在世成员的已收之和（每张票的 paid 实时 SUM） */
  paidCents: number;
  /** 在世成员的未收之和：逐票 max(0, 有效应付 − 已收)——一张票的超收不冲抵
   *  另一张票的欠款（有效应付 = 发票合计 − 有效贷项，credits.ts 唯一算术） */
  outstandingCents: number;
  /** 约定额 − 在世已开：>0 = 有期被作废/未开足；<0 = 成员行被改到超过约定。
   *  两种漂移都必须看得见，不 clamp（effectiveDueCents 同裁） */
  uninvoicedCents: number;
  parts: PlanPart[];
}

/**
 * 计划读法：头 + 逐期钱态 + 在世口径的合计。计划不存在返回 null（路由 404）。
 * 逐期的付款态与发票读写面同一条权威算术（computePaymentStatus +
 * effectiveDueCents），不各算各的。
 */
export async function getInvoicePlan(
  tx: Pick<Db, "select">,
  planId: string,
): Promise<InvoicePlanRead | null> {
  const found = await tx
    .select({
      id: schema.invoicePlans.id,
      label: schema.invoicePlans.label,
      subjectType: schema.invoicePlans.subjectType,
      subjectId: schema.invoicePlans.subjectId,
      currency: schema.invoicePlans.currency,
      totalCents: schema.invoicePlans.totalCents,
      createdAt: schema.invoicePlans.createdAt,
    })
    .from(schema.invoicePlans)
    .where(eq(schema.invoicePlans.id, planId))
    .limit(1);
  const plan = found[0];
  if (plan === undefined) {
    return null;
  }
  // 成员 + 行合计一次取齐（leftJoin + group by，贷项台账同款；行合计是生成列，
  // 空行集的票 coalesce 0——空票本不存在，防御读法）
  const memberRows = await tx
    .select({
      invoiceId: schema.invoices.id,
      number: schema.invoices.number,
      planIndex: schema.invoices.planIndex,
      status: schema.invoices.status,
      total: sql<string>`coalesce(sum(${schema.invoiceLines.lineTotalCents}), 0)`,
    })
    .from(schema.invoices)
    .leftJoin(schema.invoiceLines, eq(schema.invoiceLines.invoiceId, schema.invoices.id))
    .where(eq(schema.invoices.planId, planId))
    .groupBy(
      schema.invoices.id,
      schema.invoices.number,
      schema.invoices.planIndex,
      schema.invoices.status,
    )
    .orderBy(asc(schema.invoices.planIndex));
  const memberIds = memberRows.map((row) => row.invoiceId);
  const paidByInvoice = new Map<string, number>();
  const creditedByInvoice = new Map<string, number>();
  if (memberIds.length > 0) {
    const paidRows = await tx
      .select({
        invoiceId: schema.payments.invoiceId,
        paid: sql<string>`coalesce(sum(${schema.payments.amountCents}), 0)`,
      })
      .from(schema.payments)
      .where(inArray(schema.payments.invoiceId, memberIds))
      .groupBy(schema.payments.invoiceId);
    for (const row of paidRows) {
      paidByInvoice.set(row.invoiceId, Number(row.paid));
    }
  }
  // 有效贷项一次分组取齐（credits.ts 的 issued 口径，sumCreditCents 的逐票查询
  // 在这里会随成员数翻倍）；无贷项的票零行缺省 0
  if (memberIds.length > 0) {
    const creditedRows = await tx
      .select({
        invoiceId: schema.creditNotes.invoiceId,
        credited: sql<string>`coalesce(sum(${schema.creditNoteLines.lineTotalCents}), 0)`,
      })
      .from(schema.creditNotes)
      .innerJoin(
        schema.creditNoteLines,
        eq(schema.creditNoteLines.creditNoteId, schema.creditNotes.id),
      )
      .where(
        and(
          inArray(schema.creditNotes.invoiceId, memberIds),
          eq(schema.creditNotes.status, "issued"),
        ),
      )
      .groupBy(schema.creditNotes.invoiceId);
    for (const row of creditedRows) {
      const credited = Number(row.credited);
      if (credited > 0) {
        creditedByInvoice.set(row.invoiceId, credited);
      }
    }
  }
  const parts: PlanPart[] = memberRows.map((row) => {
    const totalCents = Number(row.total);
    const paidCents = paidByInvoice.get(row.invoiceId) ?? 0;
    const creditedCents = creditedByInvoice.get(row.invoiceId) ?? 0;
    return {
      invoiceId: row.invoiceId,
      number: row.number,
      planIndex: row.planIndex ?? 0,
      status: row.status,
      totalCents,
      creditedCents,
      paidCents,
      paymentStatus: computePaymentStatus(effectiveDueCents(totalCents, creditedCents), paidCents),
    };
  });
  const live = parts.filter((part) => part.status !== "void");
  const liveInvoicedCents = live.reduce((sum, part) => sum + part.totalCents, 0);
  const paidCents = live.reduce((sum, part) => sum + part.paidCents, 0);
  const outstandingCents = live.reduce(
    (sum, part) =>
      sum + Math.max(0, effectiveDueCents(part.totalCents, part.creditedCents) - part.paidCents),
    0,
  );
  return {
    id: plan.id,
    label: plan.label,
    subject:
      plan.subjectType !== null && plan.subjectId !== null
        ? { type: plan.subjectType, id: plan.subjectId }
        : null,
    currency: plan.currency,
    totalCents: plan.totalCents,
    createdAt: plan.createdAt,
    partCount: parts.length,
    livePartCount: live.length,
    liveInvoicedCents,
    paidCents,
    outstandingCents,
    uninvoicedCents: plan.totalCents - liveInvoicedCents,
    parts,
  };
}

/**
 * 「Part i of n」的 n：一个计划的成员数（含 void）。发票详情读的 plan 事实
 * 从这里走，不许从调用方手里的行集数出来（老系统 BUG-274 的教训）。
 */
export async function countPlanMembers(
  tx: Pick<Db, "select">,
  planId: string,
): Promise<number> {
  const rows = await tx
    .select({ count: sql<string>`count(*)` })
    .from(schema.invoices)
    .where(eq(schema.invoices.planId, planId));
  return Number(rows[0]?.count ?? 0);
}

/** 列表读的 plan 计数：全体非空 planId 一次分组（列表页恒一条查询） */
export async function countAllPlanMembers(
  tx: Pick<Db, "select">,
): Promise<Map<string, number>> {
  const rows = await tx
    .select({
      planId: schema.invoices.planId,
      count: sql<string>`count(*)`,
    })
    .from(schema.invoices)
    .where(isNotNull(schema.invoices.planId))
    .groupBy(schema.invoices.planId);
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.planId !== null) {
      counts.set(row.planId, Number(row.count));
    }
  }
  return counts;
}
