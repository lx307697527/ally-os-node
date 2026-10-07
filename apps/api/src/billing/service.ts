import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import { allocateDocumentNumber } from "../numbering/service.ts";

/**
 * 发票内核服务（#192 切片 1：草稿状态机 + 整数分金额 + 触发点幂等）。
 *
 * 设计依据 #232 §10「所有发票由系统出草稿，财务确认后才发出」（R-12-6）。
 * 老系统对照 billing.*（20260724143856_billing_core.sql）：发票靠手工创建/
 * 拆期（#88），amount_due numeric(14,2) 快照列。本内核的迁移裁决：
 *
 * - **触发点是进程内接缝，不是 HTTP 面**：打样确认（#238）、报价接受/定金
 *   （#231）、批次完工确认（phase-4）等属主域在自己的业务事务里调
 *   createDraftInvoice——草稿与触发事实同事务生灭，触发回滚则草稿从未存在。
 *   HTTP 面只服务财务手工建票（老系统的过渡面）与读法。
 * - **金额整数分，行合计是生成列**：invoice_lines.line_total_cents =
 *   round(quantity × unit_price_cents)（SQL 侧 PG numeric round，half away
 *   from zero；金额非负即四舍五入）。发票合计不落列、读面实时 SUM——快照
 *   与行漂移一类的缺陷（老 bug554 家族）在表结构上不可能存在。
 * - **触发点幂等**：(source_type, source_key) 唯一索引，同源重复投递在
 *   结构上不可能（不靠先查后插）；冲突以 InvoiceExistsError 上抛，属主域
 *   事务整体回滚。手工建票两列皆 null，不受约束。
 * - **状态机刻意三态**：draft → issued（财务确认）/ draft → void（作废）。
 *   issued 行锁定（#219 之外的第二种「签后不可改」：发票面靠状态机），
 *   更正/贷项（红冲）是后续切片的新动词，不改写已发出的行。付款态
 *   （paid/partially_paid）随收款切片（#193）expand。
 *
 * NoActiveRuleError 从 numbering 原样上抛：没有编号的单据不存在（fail
 * closed），HTTP 面映射 409 numbering_not_configured。
 */

/** 发票类型词表（pgEnum invoice_type 同款）；随触发点属主域 expand */
export const INVOICE_TYPES = [
  "deposit",
  "balance",
  "sampling_fee",
  "flavor_dev",
  "label_design",
  "storage_fee",
  "customer_material",
] as const;

export type InvoiceType = (typeof INVOICE_TYPES)[number];

/** 行输入：金额纪律在 schema 层表达（quantity 三位小数、单价整数分） */
export interface InvoiceLineInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
}

/** 触发点幂等键：属主域给（如 ("quote_accepted", "<quoteId>")），手工票为空 */
export interface InvoiceSource {
  type: string;
  key: string;
}

/** 业务锚点：产生这张票的业务事实（报价/订单/批次/打样确认…，开集） */
export interface InvoiceSubject {
  type: string;
  id: string;
}

export interface CreateDraftInvoiceInput {
  invoiceType: InvoiceType;
  lines: InvoiceLineInput[];
  subject?: InvoiceSubject;
  source?: InvoiceSource;
  createdById: string;
}

/** 同一触发事件的重复投递：属主域与 HTTP 面都映射 409 invoice_exists */
export class InvoiceExistsError extends Error {
  readonly code = "invoice_exists";
  constructor(source: InvoiceSource) {
    super(`invoice: draft already exists for source "${source.type}:${source.key}"`);
    this.name = "InvoiceExistsError";
  }
}

/** 状态不允许该动词；code 由路由映射 409（票存在但状态不对，不是 404） */
export class InvoiceStateError extends Error {
  readonly code: "not_draft" | "invoice_voided" | "not_voidable";
  constructor(code: "not_draft" | "invoice_voided" | "not_voidable") {
    super(`invoice: action not allowed in current state (${code})`);
    this.name = "InvoiceStateError";
    this.code = code;
  }
}

/** 事务句柄：属主域传自己的事务，路由传 deps.db.transaction 的回调参数 */
export type InvoiceTx = Pick<Db, "select" | "insert" | "update" | "delete">;

/**
 * 创建草稿（属主域触发点与财务手工建票同一条路径）。
 *
 * 编号在事务里分配（numbering subject "invoice"，规则在配置工作室建）；
 * source 唯一索引兜幂等——23505 映射 InvoiceExistsError，属主域捕获后让
 * 触发事务回滚（重复的打样确认不该开出第二张票）。
 */
export async function createDraftInvoice(
  tx: InvoiceTx,
  input: CreateDraftInvoiceInput,
  options: { now?: Date } = {},
): Promise<{ id: string; number: string }> {
  const now = options.now ?? new Date();
  const issued = await allocateDocumentNumber(tx, "invoice", { now });
  let rows: { id: string }[];
  try {
    rows = await tx
      .insert(schema.invoices)
      .values({
        number: issued.number,
        invoiceType: input.invoiceType,
        subjectType: input.subject?.type ?? null,
        subjectId: input.subject?.id ?? null,
        sourceType: input.source?.type ?? null,
        sourceKey: input.source?.key ?? null,
        createdById: input.createdById,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.invoices.id });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new InvoiceExistsError(
        input.source ?? { type: "unknown", key: "unknown" },
      );
    }
    throw err;
  }
  const row = rows[0];
  if (row === undefined) {
    throw new Error("invoice create: insert returned no row");
  }
  await tx.insert(schema.invoiceLines).values(
    input.lines.map((line, index) => ({
      invoiceId: row.id,
      lineNumber: index + 1,
      description: line.description,
      // numeric 列走字符串，三位小数由路由 zod 收口后原样落列
      quantity: line.quantity.toFixed(3),
      unitPriceCents: line.unitPriceCents,
    })),
  );
  return { id: row.id, number: issued.number };
}

/**
 * PATCH 换行的状态门：只有 draft 可改（发票的「可修改」只属于草稿，#192）。
 * 票不存在返回 null（路由 404）。
 */
export async function updateDraftLines(
  tx: InvoiceTx,
  invoiceId: string,
  lines: InvoiceLineInput[],
  options: { now?: Date } = {},
): Promise<{ changed: boolean } | null> {
  const now = options.now ?? new Date();
  // 行锁：并发的两个 PATCH 各自锁行串行——后到者基于前者的结果判 no-op
  const locked = await tx
    .select({ id: schema.invoices.id, status: schema.invoices.status })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId))
    .for("update")
    .limit(1);
  const invoice = locked[0];
  if (invoice === undefined) {
    return null;
  }
  if (invoice.status === "void") {
    throw new InvoiceStateError("invoice_voided");
  }
  if (invoice.status !== "draft") {
    throw new InvoiceStateError("not_draft");
  }
  const current = await tx
    .select({
      description: schema.invoiceLines.description,
      quantity: schema.invoiceLines.quantity,
      unitPriceCents: schema.invoiceLines.unitPriceCents,
    })
    .from(schema.invoiceLines)
    .where(eq(schema.invoiceLines.invoiceId, invoiceId))
    .orderBy(schema.invoiceLines.lineNumber);
  if (linesMatch(current, lines)) {
    return { changed: false };
  }
  await tx.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId));
  await tx.insert(schema.invoiceLines).values(
    lines.map((line, index) => ({
      invoiceId,
      lineNumber: index + 1,
      description: line.description,
      quantity: line.quantity.toFixed(3),
      unitPriceCents: line.unitPriceCents,
    })),
  );
  await tx
    .update(schema.invoices)
    .set({ updatedAt: now })
    .where(eq(schema.invoices.id, invoiceId));
  return { changed: true };
}

/** 现行行与提交行逐位对比（顺序敏感——行没有身份键，顺序即语义） */
function linesMatch(
  current: { description: string; quantity: string; unitPriceCents: number }[],
  submitted: InvoiceLineInput[],
): boolean {
  if (current.length !== submitted.length) return false;
  return current.every((row, i) => {
    const line = submitted[i];
    if (line === undefined) return false;
    return (
      row.description === line.description &&
      row.quantity === line.quantity.toFixed(3) &&
      row.unitPriceCents === line.unitPriceCents
    );
  });
}

/**
 * 确认发出（R-12-6 财务确认）：draft → issued，行锁定。重复确认幂等返回
 * already（审计不落第二行——no-op 不写审计的同一纪律）；void 票不可确认。
 * 票不存在返回 null（路由 404）。
 */
export async function confirmInvoice(
  tx: InvoiceTx,
  invoiceId: string,
  actorId: string,
  options: { now?: Date } = {},
): Promise<{ outcome: "issued" | "already"; totalCents: number } | null> {
  const now = options.now ?? new Date();
  const locked = await tx
    .select({ status: schema.invoices.status })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId))
    .for("update")
    .limit(1);
  const invoice = locked[0];
  if (invoice === undefined) {
    return null;
  }
  const totalCents = await sumLineTotals(tx, invoiceId);
  if (invoice.status === "issued") {
    return { outcome: "already", totalCents };
  }
  if (invoice.status === "void") {
    throw new InvoiceStateError("invoice_voided");
  }
  await tx
    .update(schema.invoices)
    .set({ status: "issued", issuedAt: now, issuedById: actorId, updatedAt: now })
    .where(eq(schema.invoices.id, invoiceId));
  return { outcome: "issued", totalCents };
}

/**
 * 作废草稿：draft → void（行随 CASCADE 留着？——行保留，票是记录不是草稿对话；
 * totalCents 仍可查）。已发出的票不可作废：更正走贷项切片（红冲是动词，不是
 * 对已发行的改写）。重复作废幂等返回 already。票不存在返回 null（路由 404）。
 */
export async function voidInvoice(
  tx: InvoiceTx,
  invoiceId: string,
  actorId: string,
  reason: string | null,
  options: { now?: Date } = {},
): Promise<{ outcome: "voided" | "already"; totalCents: number } | null> {
  const now = options.now ?? new Date();
  const locked = await tx
    .select({ status: schema.invoices.status })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId))
    .for("update")
    .limit(1);
  const invoice = locked[0];
  if (invoice === undefined) {
    return null;
  }
  const totalCents = await sumLineTotals(tx, invoiceId);
  if (invoice.status === "void") {
    return { outcome: "already", totalCents };
  }
  if (invoice.status === "issued") {
    throw new InvoiceStateError("not_voidable");
  }
  await tx
    .update(schema.invoices)
    .set({
      status: "void",
      voidedAt: now,
      voidedById: actorId,
      voidReason: reason,
      updatedAt: now,
    })
    .where(eq(schema.invoices.id, invoiceId));
  return { outcome: "voided", totalCents };
}

/** 发票合计 = 行合计生成列的实时 SUM（不落快照列的裁决，见文件头） */
export async function sumLineTotals(
  tx: Pick<Db, "select">,
  invoiceId: string,
): Promise<number> {
  const rows = await tx
    .select({
      total: sql<string>`coalesce(sum(${schema.invoiceLines.lineTotalCents}), 0)`,
    })
    .from(schema.invoiceLines)
    .where(eq(schema.invoiceLines.invoiceId, invoiceId));
  const row = rows[0];
  return Number(row?.total ?? 0);
}

/** 一个 subject 名下的全部发票锚点读法（收款状态回写 #241 的路标） */
export async function listInvoicesForSubject(
  tx: Pick<Db, "select">,
  subject: InvoiceSubject,
): Promise<{ id: string; number: string; status: string }[]> {
  return tx
    .select({
      id: schema.invoices.id,
      number: schema.invoices.number,
      status: schema.invoices.status,
    })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.subjectType, subject.type),
        eq(schema.invoices.subjectId, subject.id),
      ),
    );
}

/** pg 唯一约束冲突（23505）：沿 DrizzleQueryError 因果链找码（routes 同款） */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "23505") return true;
    current = candidate.cause;
  }
  return false;
}
