import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import { allocateDocumentNumber } from "../numbering/service.ts";
import { sumLineTotals } from "./service.ts";

/**
 * 贷项单服务（#192 红冲切片：issued 票的更正动词）。
 *
 * 设计依据 #232 §10「分期、更正、贷项」。发票内核（billing/service.ts）的
 * 预留承诺在此兑现：已发出的票行锁定，红冲**不是对已发行行的改写，而是一张
 * 新单据**——贷项单引用原票，冲抵多少由自己的行（生成列合计）陈述；原票面额
 * 恒不变。老系统没有贷项概念（更正靠 status='refunded' 改写快照），credit memo
 * 的对齐对象是 QuickBooks（#181 推送的路标）。
 *
 * 三个状态动词与发票同构（R-12-6 同一道人闸）：draft → issued（财务确认后
 * 冲抵生效）、draft → void；issued 是终态——开错的贷项单按 QuickBooks 同款
 * 模式用新发票冲回，不在本表翻烧饼。
 *
 * **冲抵边界**：一张票名下有效贷项合计 ≤ 原票合计，在创建事务的发票行锁内
 * 校验。原票 issued 后行合计冻结、贷项只增或经 void 缩小——边界自此无漂移
 * 窗口，超冲映射 409 credit_exceeds_invoice（把应付冲成负数不是更正，是另一
 * 笔交易；退款走 #240）。
 *
 * **有效应付的唯一权威算术**：effectiveDueCents = 发票合计 − 有效贷项合计。
 * 付款态派生（computePaymentStatus）、收款 checkout 的结算额、逾期扫描的
 * outstanding 全部从这里取，不各算各的（快照漂移的 bug554 家族在「三个派生
 * 值各自结构性无漂移」的前提下没有存在空间）。
 *
 * 锁纪律：createCreditNote / confirmCreditNote / voidCreditNote 先锁单据行
 * （创建时先锁原票行），同一张票的动词串行——边界校验与冲抵合计因此是精确值。
 */

/** 贷项单三态（pgEnum credit_note_status 同款）；语义见文件头 */
export const CREDIT_NOTE_STATUSES = ["draft", "issued", "void"] as const;

export type CreditNoteStatus = (typeof CREDIT_NOTE_STATUSES)[number];

/** 行输入：金额纪律在 schema 层表达（quantity 三位小数、单价整数分）——发票行同款 */
export interface CreditNoteLineInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
}

export interface CreateCreditNoteInput {
  invoiceId: string;
  reason: string;
  lines: CreditNoteLineInput[];
  createdById: string;
}

/** 状态不允许该动词；code 由路由映射 409（单据存在但状态不对，不是 404） */
export class CreditNoteStateError extends Error {
  readonly code: "not_issued" | "invoice_voided" | "credit_note_voided" | "not_voidable";
  constructor(code: "not_issued" | "invoice_voided" | "credit_note_voided" | "not_voidable") {
    super(`credit note: action not allowed in current state (${code})`);
    this.name = "CreditNoteStateError";
    this.code = code;
  }
}

/** 有效贷项合计超过原票合计：409 credit_exceeds_invoice（见文件头） */
export class CreditNoteExceedsInvoiceError extends Error {
  readonly code = "credit_exceeds_invoice";
  readonly invoiceNumber: string;
  readonly totalCents: number;
  readonly attemptedCents: number;
  constructor(invoiceNumber: string, totalCents: number, attemptedCents: number) {
    super(
      `credit note: active credits (${attemptedCents}) would exceed invoice ${invoiceNumber} total (${totalCents})`,
    );
    this.name = "CreditNoteExceedsInvoiceError";
    this.invoiceNumber = invoiceNumber;
    this.totalCents = totalCents;
    this.attemptedCents = attemptedCents;
  }
}

/** 事务句柄（billing/service.ts InvoiceTx 同款）：属主域传自己的事务 */
export type CreditNoteTx = Pick<Db, "select" | "insert" | "update" | "delete">;

/**
 * 创建贷项草稿（财务手工建单；#239 触发域进场时走同一接缝）。
 *
 * 锁原票行 → 状态门（只对 issued 票开，draft 该改草稿、void 是死票）→ 发号
 * （numbering subject "credit_note"，无生效规则 409 fail closed 同发票）→ 插入
 * 单据与行 → 行锁内重读边界（有效贷项合计 + 本单合计 ≤ 原票合计）。原票不存
 * 在返回 null（路由 404）。币种从原票抄录，调用方给不了也不需要给。
 */
export async function createCreditNote(
  tx: CreditNoteTx,
  input: CreateCreditNoteInput,
  options: { now?: Date } = {},
): Promise<{ id: string; number: string; creditedCents: number } | null> {
  const now = options.now ?? new Date();
  const locked = await tx
    .select({
      number: schema.invoices.number,
      status: schema.invoices.status,
      currency: schema.invoices.currency,
    })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, input.invoiceId))
    .for("update")
    .limit(1);
  const invoice = locked[0];
  if (invoice === undefined) {
    return null;
  }
  if (invoice.status === "void") {
    throw new CreditNoteStateError("invoice_voided");
  }
  if (invoice.status !== "issued") {
    throw new CreditNoteStateError("not_issued");
  }
  const issued = await allocateDocumentNumber(tx, "credit_note", { now });
  const inserted = await tx
    .insert(schema.creditNotes)
    .values({
      number: issued.number,
      invoiceId: input.invoiceId,
      reason: input.reason,
      currency: invoice.currency,
      createdById: input.createdById,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.creditNotes.id });
  const row = inserted[0];
  if (row === undefined) {
    throw new Error("credit note create: insert returned no row");
  }
  await tx.insert(schema.creditNoteLines).values(
    input.lines.map((line, index) => ({
      creditNoteId: row.id,
      lineNumber: index + 1,
      description: line.description,
      // numeric 列走字符串，三位小数由路由 zod 收口后原样落列（发票行同款）
      quantity: line.quantity.toFixed(3),
      unitPriceCents: line.unitPriceCents,
    })),
  );
  // 边界校验在行落库后：合计只认生成列（PG 是唯一舍入权威），超界整单回滚；
  // 口径是 sumActiveCreditCents（draft 也占位）——两张草稿各自过界、先后确认
  // 就超冲的窗口在这里关死
  const activeCreditedCents = await sumActiveCreditCents(tx, input.invoiceId);
  const invoiceTotalCents = await sumLineTotals(tx, input.invoiceId);
  if (activeCreditedCents > invoiceTotalCents) {
    throw new CreditNoteExceedsInvoiceError(invoice.number, invoiceTotalCents, activeCreditedCents);
  }
  return { id: row.id, number: issued.number, creditedCents: activeCreditedCents };
}

/**
 * 确认贷项单（R-12-6）：draft → issued，冲抵自此计入有效应付。重复确认幂等
 * 返回 already（no-op 不写审计，发票确认同一纪律）；void 单不可确认。单据不
 * 存在返回 null（路由 404）。
 */
export async function confirmCreditNote(
  tx: CreditNoteTx,
  creditNoteId: string,
  actorId: string,
  options: { now?: Date } = {},
): Promise<{
  outcome: "issued" | "already";
  invoiceId: string;
  invoiceNumber: string;
  number: string;
  creditedCents: number;
} | null> {
  const now = options.now ?? new Date();
  const locked = await tx
    .select({ status: schema.creditNotes.status, number: schema.creditNotes.number, invoiceId: schema.creditNotes.invoiceId })
    .from(schema.creditNotes)
    .where(eq(schema.creditNotes.id, creditNoteId))
    .for("update")
    .limit(1);
  const creditNote = locked[0];
  if (creditNote === undefined) {
    return null;
  }
  if (creditNote.status === "void") {
    throw new CreditNoteStateError("credit_note_voided");
  }
  const invoice = await lockInvoiceForCredit(tx, creditNote.invoiceId);
  if (invoice === undefined) {
    throw new Error(`credit note confirm: invoice ${creditNote.invoiceId} missing for note ${creditNoteId}`);
  }
  if (creditNote.status === "issued") {
    return {
      outcome: "already",
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      number: creditNote.number,
      creditedCents: await sumCreditCents(tx, creditNote.invoiceId),
    };
  }
  await tx
    .update(schema.creditNotes)
    .set({ status: "issued", issuedAt: now, issuedById: actorId, updatedAt: now })
    .where(eq(schema.creditNotes.id, creditNoteId));
  return {
    outcome: "issued",
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    number: creditNote.number,
    creditedCents: await sumCreditCents(tx, creditNote.invoiceId),
  };
}

/**
 * 作废贷项草稿：draft → void（行随 CASCADE 留着——单据是记录不是草稿对话，
 * 发票作废同裁）。已发出的贷项单不可作废（issued 是终态，开错按 QuickBooks
 * 同款模式用新发票冲回）。重复作废幂等返回 already。单据不存在返回 null。
 */
export async function voidCreditNote(
  tx: CreditNoteTx,
  creditNoteId: string,
  actorId: string,
  reason: string | null,
  options: { now?: Date } = {},
): Promise<{
  outcome: "voided" | "already";
  invoiceId: string;
  invoiceNumber: string;
  number: string;
  creditedCents: number;
} | null> {
  const now = options.now ?? new Date();
  const locked = await tx
    .select({ status: schema.creditNotes.status, number: schema.creditNotes.number, invoiceId: schema.creditNotes.invoiceId })
    .from(schema.creditNotes)
    .where(eq(schema.creditNotes.id, creditNoteId))
    .for("update")
    .limit(1);
  const creditNote = locked[0];
  if (creditNote === undefined) {
    return null;
  }
  const invoice = await lockInvoiceForCredit(tx, creditNote.invoiceId);
  if (invoice === undefined) {
    throw new Error(`credit note void: invoice ${creditNote.invoiceId} missing for note ${creditNoteId}`);
  }
  if (creditNote.status === "void") {
    return {
      outcome: "already",
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      number: creditNote.number,
      creditedCents: await sumCreditCents(tx, creditNote.invoiceId),
    };
  }
  if (creditNote.status === "issued") {
    throw new CreditNoteStateError("not_voidable");
  }
  await tx
    .update(schema.creditNotes)
    .set({ status: "void", voidedAt: now, voidedById: actorId, voidReason: reason, updatedAt: now })
    .where(eq(schema.creditNotes.id, creditNoteId));
  return {
    outcome: "voided",
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    number: creditNote.number,
    creditedCents: await sumCreditCents(tx, creditNote.invoiceId),
  };
}

/**
 * 有效贷项合计 = **issued 且未 void** 单的行合计生成列实时 SUM（收款 SUM 同裁：
 * 实时派生、无快照）。草稿不计入——R-12-6 的闸门在财务确认，草稿贷项不能让
 * 发票提前变「paid」（付款态派生、checkout 结算额、逾期扫描 outstanding 都
 * 从这里取）。
 */
export async function sumCreditCents(tx: Pick<Db, "select">, invoiceId: string): Promise<number> {
  const rows = await tx
    .select({ credited: sql<string>`coalesce(sum(${schema.creditNoteLines.lineTotalCents}), 0)` })
    .from(schema.creditNotes)
    .innerJoin(schema.creditNoteLines, eq(schema.creditNoteLines.creditNoteId, schema.creditNotes.id))
    .where(
      and(
        eq(schema.creditNotes.invoiceId, invoiceId),
        eq(schema.creditNotes.status, "issued"),
      ),
    );
  return Number(rows[0]?.credited ?? 0);
}

/**
 * 冲抵边界的口径：**所有在世（未 void）单**（draft + issued）的合计。草稿也
 * 占边界——两张草稿各自都在边界内、先后确认就超冲的窗口必须在这里关死；
 * 创建时占位、确认时无需复查（草稿只会经 void 减少），边界自此无漂移窗口。
 */
async function sumActiveCreditCents(tx: Pick<Db, "select">, invoiceId: string): Promise<number> {
  const rows = await tx
    .select({ credited: sql<string>`coalesce(sum(${schema.creditNoteLines.lineTotalCents}), 0)` })
    .from(schema.creditNotes)
    .innerJoin(schema.creditNoteLines, eq(schema.creditNoteLines.creditNoteId, schema.creditNotes.id))
    .where(
      and(
        eq(schema.creditNotes.invoiceId, invoiceId),
        sql`${schema.creditNotes.status} <> 'void'`,
      ),
    );
  return Number(rows[0]?.credited ?? 0);
}

/**
 * 有效应付的唯一权威算术（文件头）：发票合计 − 有效贷项合计。冲抵边界由
 * 创建事务保证不为负；这里不 clamp——边界若被破坏，负数暴露问题比吞掉它诚实。
 */
export function effectiveDueCents(totalCents: number, creditedCents: number): number {
  return totalCents - creditedCents;
}

/** 一张票的贷项台账读法（贷项动作 web 面的接缝）；票不存在返回 null */
export async function listCreditNotesForInvoice(
  tx: Pick<Db, "select">,
  invoiceId: string,
): Promise<
  | {
      creditedCents: number;
      creditNotes: {
        id: string;
        number: string;
        status: string;
        reason: string;
        currency: string;
        totalCents: number;
        issuedAt: Date | null;
        voidedAt: Date | null;
        voidReason: string | null;
        createdAt: Date;
      }[];
    }
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
  const notes = await tx
    .select({
      id: schema.creditNotes.id,
      number: schema.creditNotes.number,
      status: schema.creditNotes.status,
      reason: schema.creditNotes.reason,
      currency: schema.creditNotes.currency,
      issuedAt: schema.creditNotes.issuedAt,
      voidedAt: schema.creditNotes.voidedAt,
      voidReason: schema.creditNotes.voidReason,
      createdAt: schema.creditNotes.createdAt,
      totalCents: sql<string>`coalesce(sum(${schema.creditNoteLines.lineTotalCents}), 0)`,
    })
    .from(schema.creditNotes)
    .leftJoin(schema.creditNoteLines, eq(schema.creditNoteLines.creditNoteId, schema.creditNotes.id))
    .where(eq(schema.creditNotes.invoiceId, invoiceId))
    .groupBy(
      schema.creditNotes.id,
      schema.creditNotes.number,
      schema.creditNotes.status,
      schema.creditNotes.reason,
      schema.creditNotes.currency,
      schema.creditNotes.issuedAt,
      schema.creditNotes.voidedAt,
      schema.creditNotes.voidReason,
      schema.creditNotes.createdAt,
    )
    .orderBy(asc(schema.creditNotes.createdAt));
  return {
    // 台账首行的有效合计只数 issued（草稿未过财务闸，同 sumCreditCents 口径）
    creditedCents: notes
      .filter((note) => note.status === "issued")
      .reduce((sum, note) => sum + Number(note.totalCents), 0),
    creditNotes: notes.map((note) => ({ ...note, totalCents: Number(note.totalCents) })),
  };
}

/** 贷项单详情读法（含行）；单据不存在返回 null（路由 404） */
export async function getCreditNote(
  tx: Pick<Db, "select">,
  creditNoteId: string,
): Promise<
  | {
      id: string;
      number: string;
      invoiceId: string;
      invoiceNumber: string;
      status: string;
      reason: string;
      currency: string;
      totalCents: number;
      issuedAt: Date | null;
      voidedAt: Date | null;
      voidReason: string | null;
      createdAt: Date;
      lines: {
        id: string;
        lineNumber: number;
        description: string;
        quantity: string;
        unitPriceCents: number;
        lineTotalCents: number;
      }[];
    }
  | null
> {
  const found = await tx
    .select({
      id: schema.creditNotes.id,
      number: schema.creditNotes.number,
      invoiceId: schema.creditNotes.invoiceId,
      invoiceNumber: schema.invoices.number,
      status: schema.creditNotes.status,
      reason: schema.creditNotes.reason,
      currency: schema.creditNotes.currency,
      issuedAt: schema.creditNotes.issuedAt,
      voidedAt: schema.creditNotes.voidedAt,
      voidReason: schema.creditNotes.voidReason,
      createdAt: schema.creditNotes.createdAt,
    })
    .from(schema.creditNotes)
    .innerJoin(schema.invoices, eq(schema.invoices.id, schema.creditNotes.invoiceId))
    .where(eq(schema.creditNotes.id, creditNoteId))
    .limit(1);
  const note = found[0];
  if (note === undefined) {
    return null;
  }
  const lines = await tx
    .select({
      id: schema.creditNoteLines.id,
      lineNumber: schema.creditNoteLines.lineNumber,
      description: schema.creditNoteLines.description,
      quantity: schema.creditNoteLines.quantity,
      unitPriceCents: schema.creditNoteLines.unitPriceCents,
      lineTotalCents: schema.creditNoteLines.lineTotalCents,
    })
    .from(schema.creditNoteLines)
    .where(eq(schema.creditNoteLines.creditNoteId, creditNoteId))
    .orderBy(asc(schema.creditNoteLines.lineNumber));
  return {
    ...note,
    totalCents: lines.reduce((sum, line) => sum + line.lineTotalCents, 0),
    lines,
  };
}

/** 先票后单的锁序补齐：confirm/void 动词对同一张原票串行（收款动词同裁） */
async function lockInvoiceForCredit(
  tx: CreditNoteTx,
  invoiceId: string,
): Promise<{ id: string; number: string } | undefined> {
  const rows = await tx
    .select({ id: schema.invoices.id, number: schema.invoices.number })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId))
    .for("update")
    .limit(1);
  return rows[0];
}
