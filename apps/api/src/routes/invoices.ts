import { asc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { Storage } from "@ally/storage";
import type { AppEnv } from "../auth/session.ts";
import { requirePermission } from "../authz/middleware.ts";
import { recordAudit } from "../audit/audit-log.ts";
import { archiveInvoiceDocument, getOrBackfillInvoicePdf } from "../billing/pdf.ts";
import {
  confirmInvoice,
  createDraftInvoice,
  INVOICE_TYPES,
  type CreateDraftInvoiceInput,
  InvoiceExistsError,
  InvoiceStateError,
  sumLineTotals,
  updateDraftLines,
  voidInvoice,
} from "../billing/service.ts";
import { effectiveDueCents, sumCreditCents } from "../billing/credits.ts";
import { computePaymentStatus, sumPaidCents } from "../billing/payments.ts";
import { countAllPlanMembers, countPlanMembers } from "../billing/installments.ts";
import { NoActiveRuleError } from "../numbering/service.ts";

/**
 * 发票端点（#192 切片 1：发票内核的财务面）。
 *
 * 全部在 `invoices.manage` 权限点后面（finance/owner 默认持有，#232 §12 财务
 * 「确认发送发票」+ 老板「全部查看」）。三个动词家族：
 *
 * - **POST /api/invoices**：手工建草稿（老系统的过渡面）。触发点的系统生成
 *   不走 HTTP——属主域（打样确认 #238 / 报价接受 #231 / 批次完工 phase-4）
 *   在自己的业务事务里调 billing/service.ts 的 createDraftInvoice，同事务
 *   生灭；body 里的 source 字段就是为属主域语义预留的同形入口（手工票不传）。
 * - **PATCH /api/invoices/:id**：草稿换行（整体替换——行没有身份键，顺序即
 *   语义，增量 diff 才是漂移的来源）；与现行逐位相同则幂等返回不留审计。
 * - **POST …/confirm、POST …/void**：状态机的两个动词（R-12-6 确认后发出；
 *   作废只对草稿，红冲/贷项是后续切片）。重复动词幂等返回现状，不落审计。
 *
 * 金额纪律：quantity 三位小数、单价整数分、行合计是 DB 生成列——服务端是
 * 唯一权威（RULE-007），客户端只提交数量与单价。空票不存在（老 bug500 在
 * 创建面收口：lines 至少一行）。
 */

// 三位小数：浮点直判会被 0.1 * 1000 !== 100 这类表示误差误伤，走十进制的
// 字符串往返（toFixed 即「最多三位」的规范形）
function atMostThreeDecimals(q: number): boolean {
  return Number(q.toFixed(3)) === q;
}

const MAX_LINE_TOTAL_CENTS = 2_147_483_647; // int4 上限：生成列的存储边界

const lineInput = z
  .object({
    description: z.string().trim().min(1).max(500),
    quantity: z
      .number()
      .positive()
      .max(999_999_999)
      .refine(atMostThreeDecimals, "quantity supports at most 3 decimal places"),
    unitPriceCents: z.number().int().min(0).max(2_000_000_000),
  })
  .refine(
    (line) => Math.round(line.quantity * line.unitPriceCents) <= MAX_LINE_TOTAL_CENTS,
    "line total exceeds the stored limit",
  );

const subjectRefine = (body: {
  subjectType?: string | undefined;
  subjectId?: string | undefined;
}) => (body.subjectType === undefined) === (body.subjectId === undefined);
const sourceRefine = (body: {
  sourceType?: string | undefined;
  sourceKey?: string | undefined;
}) => (body.sourceType === undefined) === (body.sourceKey === undefined);

const createBody = z
  .object({
    invoiceType: z.enum(INVOICE_TYPES),
    subjectType: z.string().trim().min(1).max(64).optional(),
    subjectId: z.uuid().optional(),
    sourceType: z.string().trim().min(1).max(64).optional(),
    sourceKey: z.string().trim().min(1).max(200).optional(),
    lines: z.array(lineInput).min(1).max(200),
  })
  .refine(subjectRefine, "subjectType and subjectId must be provided together")
  .refine(sourceRefine, "sourceType and sourceKey must be provided together");

const patchBody = z.object({ lines: z.array(lineInput).min(1).max(200) });

const voidBody = z.object({ reason: z.string().trim().min(1).max(500).optional() });

// 确认发出时可选的账期（R-12-7）：0 = 见票即付，365 封顶（两年账期不是发票是
// 关系问题）。dueAt 由服务端从 issuedAt 算，body 只收天数不收时刻（RULE-007）
const confirmBody = z.object({ dueInDays: z.number().int().min(0).max(365).optional() });

const invoiceStatusValues = ["draft", "issued", "void"] as const;

function presentInvoice(
  row: {
    id: string;
    number: string;
    invoiceType: string;
    status: string;
    currency: string;
    subjectType: string | null;
    subjectId: string | null;
    planId: string | null;
    planIndex: number | null;
    issuedAt: Date | null;
    dueAt: Date | null;
    voidedAt: Date | null;
    voidReason: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  totalCents: number,
  creditedCents: number,
  paidCents: number,
  planCount: number | undefined,
  lines?: {
    id: string;
    lineNumber: number;
    description: string;
    quantity: string;
    unitPriceCents: number;
    lineTotalCents: number;
  }[],
) {
  return {
    id: row.id,
    number: row.number,
    invoiceType: row.invoiceType,
    status: row.status,
    currency: row.currency,
    subject:
      row.subjectType !== null && row.subjectId !== null
        ? { type: row.subjectType, id: row.subjectId }
        : null,
    // 分期成员事实（#192 分期切片）：i 是创建时落定的序数，n 是成员数（含
    // void，读时派生——不从行集数出来）；null = 非分期票
    plan:
      row.planId !== null && row.planIndex !== null && planCount !== undefined
        ? { id: row.planId, index: row.planIndex, count: planCount }
        : null,
    totalCents,
    // 有效贷项合计（#192 红冲切片）：未 void 贷项单实时 SUM，原票面额不变
    creditedCents,
    // 付款态是派生值（billing/payments.ts）：应付口径是有效应付（发票合计 −
    // 有效贷项）；draft/void 票没有付款行，恒 unpaid
    paidCents,
    paymentStatus: computePaymentStatus(effectiveDueCents(totalCents, creditedCents), paidCents),
    issuedAt: row.issuedAt,
    // null = 未约定账期（不进逾期扫描，R-12-7 的语义半边由数据自己说）
    dueAt: row.dueAt,
    voidedAt: row.voidedAt,
    voidReason: row.voidReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(lines !== undefined
      ? {
          lines: lines.map((line) => ({
            id: line.id,
            lineNumber: line.lineNumber,
            description: line.description,
            quantity: line.quantity,
            unitPriceCents: line.unitPriceCents,
            lineTotalCents: line.lineTotalCents,
          })),
        }
      : {}),
  };
}

export function invoicesRoutes(deps: { db: Db; logger: Logger; storage: Storage }) {
  const app = new Hono<AppEnv>();
  const requireInvoicesManage = requirePermission("invoices.manage");

  app.post("/api/invoices", requireInvoicesManage, async (c) => {
    const parsed = createBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const body = parsed.data;
    const actorId = c.get("user").id;
    const input: CreateDraftInvoiceInput = {
      invoiceType: body.invoiceType,
      lines: body.lines,
      createdById: actorId,
    };
    if (body.subjectType !== undefined && body.subjectId !== undefined) {
      input.subject = { type: body.subjectType, id: body.subjectId };
    }
    if (body.sourceType !== undefined && body.sourceKey !== undefined) {
      input.source = { type: body.sourceType, key: body.sourceKey };
    }
    let created: { id: string; number: string; totalCents: number };
    try {
      created = await deps.db.transaction(async (tx) => {
        const result = await createDraftInvoice(tx, input);
        const totalCents = await sumLineTotals(tx, result.id);
        return { ...result, totalCents };
      });
    } catch (err) {
      // 没有编号的单据不存在：fail closed 映射成可操作的失败——去配置工作室
      // 给 invoice 建一条生效编号规则（不是 500 的配置事故）
      if (err instanceof NoActiveRuleError) {
        return c.json({ error: "numbering_not_configured" }, 409);
      }
      if (err instanceof InvoiceExistsError) {
        return c.json({ error: "invoice_exists" }, 409);
      }
      throw err;
    }
    await recordAudit(deps.db, {
      actor: actorId,
      action: "invoice.created",
      target: created.id,
      detail: {
        number: created.number,
        invoiceType: body.invoiceType,
        ...(input.subject !== undefined ? { subjectType: input.subject.type, subjectId: input.subject.id } : {}),
        ...(input.source !== undefined ? { sourceType: input.source.type, sourceKey: input.source.key } : {}),
        lineCount: body.lines.length,
        totalCents: created.totalCents,
      },
    });
    return c.json({ id: created.id, number: created.number }, 201);
  });

  app.get("/api/invoices", requireInvoicesManage, async (c) => {
    const status = z.enum(invoiceStatusValues).safeParse(c.req.query("status"));
    const where = status.success ? eq(schema.invoices.status, status.data) : undefined;
    // 合计两次分组查询取齐（行合计、有效收款各自按票 SUM）+ 头行，共三条固定
    // 查询不随票数增长——付款态进列表是本切片的财务主读法（哪些票没收齐钱）。
    // 不用相关子查询：drizzle 在 sql`` 模板里渲染不带表限定的裸列名，多表关联
    // 会被内层表影子化（实测 total 恒 0）。
    const rows = await deps.db
      .select()
      .from(schema.invoices)
      .where(where)
      .orderBy(asc(schema.invoices.createdAt));
    const lineSums = await deps.db
      .select({
        invoiceId: schema.invoiceLines.invoiceId,
        total: sql<string>`coalesce(sum(${schema.invoiceLines.lineTotalCents}), 0)`,
      })
      .from(schema.invoiceLines)
      .groupBy(schema.invoiceLines.invoiceId);
    const paidSums = await deps.db
      .select({
        invoiceId: schema.payments.invoiceId,
        paid: sql<string>`coalesce(sum(${schema.payments.amountCents}), 0)`,
      })
      .from(schema.payments)
      .where(isNull(schema.payments.voidedAt))
      .groupBy(schema.payments.invoiceId);
    const creditedSums = await deps.db
      .select({
        invoiceId: schema.creditNotes.invoiceId,
        credited: sql<string>`coalesce(sum(${schema.creditNoteLines.lineTotalCents}), 0)`,
      })
      .from(schema.creditNotes)
      .innerJoin(
        schema.creditNoteLines,
        eq(schema.creditNoteLines.creditNoteId, schema.creditNotes.id),
      )
      .where(eq(schema.creditNotes.status, "issued"))
      .groupBy(schema.creditNotes.invoiceId);
    // 分期成员数（#192 分期切片）：全体 planId 一次分组，「n」恒读时派生
    const planCounts = await countAllPlanMembers(deps.db);
    const totals = new Map(lineSums.map((row) => [row.invoiceId, Number(row.total)]));
    const paids = new Map(paidSums.map((row) => [row.invoiceId, Number(row.paid)]));
    const crediteds = new Map(creditedSums.map((row) => [row.invoiceId, Number(row.credited)]));
    return c.json({
      invoices: rows.map((row) =>
        presentInvoice(
          row,
          totals.get(row.id) ?? 0,
          crediteds.get(row.id) ?? 0,
          paids.get(row.id) ?? 0,
          row.planId !== null ? planCounts.get(row.planId) : undefined,
        ),
      ),
    });
  });

  app.get("/api/invoices/:id", requireInvoicesManage, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const found = await deps.db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.id, id.data))
      .limit(1);
    const row = found[0];
    if (row === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    const lines = await deps.db
      .select({
        id: schema.invoiceLines.id,
        lineNumber: schema.invoiceLines.lineNumber,
        description: schema.invoiceLines.description,
        quantity: schema.invoiceLines.quantity,
        unitPriceCents: schema.invoiceLines.unitPriceCents,
        lineTotalCents: schema.invoiceLines.lineTotalCents,
      })
      .from(schema.invoiceLines)
      .where(eq(schema.invoiceLines.invoiceId, row.id))
      .orderBy(asc(schema.invoiceLines.lineNumber));
    const totalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
    const creditedCents = await sumCreditCents(deps.db, row.id);
    const paidCents = await sumPaidCents(deps.db, row.id);
    // 「Part i of n」的 n 读时派生（成员数含 void），不从行集数出来
    const planCount =
      row.planId !== null ? await countPlanMembers(deps.db, row.planId) : undefined;
    return c.json(presentInvoice(row, totalCents, creditedCents, paidCents, planCount, lines));
  });

  app.patch("/api/invoices/:id", requireInvoicesManage, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const parsed = patchBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const actorId = c.get("user").id;
    let changed: { changed: boolean } | null;
    let totalCents = 0;
    try {
      changed = await deps.db.transaction(async (tx) => {
        const result = await updateDraftLines(tx, id.data, parsed.data.lines);
        if (result?.changed !== true) {
          return result;
        }
        totalCents = await sumLineTotals(tx, id.data);
        return result;
      });
    } catch (err) {
      return stateError(c, err);
    }
    if (changed === null) {
      return c.json({ error: "not_found" }, 404);
    }
    if (changed.changed) {
      await recordAudit(deps.db, {
        actor: actorId,
        action: "invoice.updated",
        target: id.data,
        detail: { fields: ["lines"], lineCount: parsed.data.lines.length, totalCents },
      });
    }
    return c.json({ status: "ok" });
  });

  app.post("/api/invoices/:id/confirm", requireInvoicesManage, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    // body 可省（不带账期 = 未约定，dueAt null）
    const parsed = confirmBody.safeParse((await c.req.json().catch(() => undefined)) ?? {});
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const actorId = c.get("user").id;
    let confirmed: {
      outcome: "issued" | "already" | null;
      number: string;
      totalCents: number;
      dueAt: Date | null;
    };
    try {
      confirmed = await deps.db.transaction(async (tx) => {
        const result = await confirmInvoice(tx, id.data, actorId, {
          dueInDays: parsed.data.dueInDays,
        });
        if (result === null) {
          return { outcome: null, number: "", totalCents: 0, dueAt: null };
        }
        const header = await tx
          .select({ number: schema.invoices.number })
          .from(schema.invoices)
          .where(eq(schema.invoices.id, id.data))
          .limit(1);
        return {
          outcome: result.outcome,
          number: header[0]?.number ?? "",
          totalCents: result.totalCents,
          dueAt: result.dueAt,
        };
      });
    } catch (err) {
      return stateError(c, err);
    }
    if (confirmed.outcome === null) {
      return c.json({ error: "not_found" }, 404);
    }
    if (confirmed.outcome === "issued") {
      await recordAudit(deps.db, {
        actor: actorId,
        action: "invoice.confirmed",
        target: id.data,
        detail: {
          number: confirmed.number,
          totalCents: confirmed.totalCents,
          ...(parsed.data.dueInDays !== undefined && confirmed.dueAt !== null
            ? { dueInDays: parsed.data.dueInDays, dueAt: confirmed.dueAt.toISOString() }
            : {}),
        },
      });
      // 确认时刻存档（#128）：渲染 + 落桶 + 记账，幂等。存档失败不拦确认
      // （发票状态是事实，PDF 是它的投影）——读路径发现 issued 无存档会补档
      try {
        await archiveInvoiceDocument(deps.db, deps.storage, id.data, actorId);
      } catch (err) {
        deps.logger.warn({ err, invoiceId: id.data }, "invoice document archive failed");
      }
    }
    return c.json({ status: confirmed.outcome });
  });

  app.post("/api/invoices/:id/void", requireInvoicesManage, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    // body 可省（作废无必填字段）——无 body 的 POST 也是合法请求
    const parsed = voidBody.safeParse((await c.req.json().catch(() => undefined)) ?? {});
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const actorId = c.get("user").id;
    let voided: { outcome: "voided" | "already" | null; number: string; totalCents: number };
    try {
      voided = await deps.db.transaction(async (tx) => {
        const result = await voidInvoice(tx, id.data, actorId, parsed.data.reason ?? null);
        if (result === null) {
          return { outcome: null, number: "", totalCents: 0 };
        }
        const header = await tx
          .select({ number: schema.invoices.number })
          .from(schema.invoices)
          .where(eq(schema.invoices.id, id.data))
          .limit(1);
        return {
          outcome: result.outcome,
          number: header[0]?.number ?? "",
          totalCents: result.totalCents,
        };
      });
    } catch (err) {
      return stateError(c, err);
    }
    if (voided.outcome === null) {
      return c.json({ error: "not_found" }, 404);
    }
    if (voided.outcome === "voided") {
      await recordAudit(deps.db, {
        actor: actorId,
        action: "invoice.voided",
        target: id.data,
        detail: {
          number: voided.number,
          totalCents: voided.totalCents,
          ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
        },
      });
    }
    return c.json({ status: voided.outcome });
  });

  // 单据字节（#128）：同一份 PDF 服务端生成——后台预览、后续邮件附件、客户
  // 门户下载共用一个面。draft 现渲现回（DRAFT 横幅进版面，不落桶）；issued
  // 读确认时刻的存档原件（byte-for-byte，模板变更不影响已发出的票），确认时
  // 存档失败的由本路径补档；void 无文档可回（作废票不是商业文件）。
  app.get("/api/invoices/:id/pdf", requireInvoicesManage, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const actorId = c.get("user").id;
    let document: Awaited<ReturnType<typeof getOrBackfillInvoicePdf>>;
    try {
      document = await getOrBackfillInvoicePdf(deps.db, deps.storage, id.data, actorId);
    } catch (err) {
      // 存档读回失败（实现缺 get 能力/桶故障）是部署问题，不是 404
      deps.logger.error({ err, invoiceId: id.data }, "invoice pdf read failed");
      return c.json({ error: "storage_unavailable" }, 500);
    }
    if ("state" in document) {
      if (document.state === "not_found") return c.json({ error: "not_found" }, 404);
      return c.json({ error: "invoice_void" }, 409);
    }
    c.header("Content-Type", "application/pdf");
    c.header("Content-Disposition", `inline; filename="${document.fileName}"`);
    return c.body(Buffer.from(document.bytes));
  });

  return app;
}

/** 状态机错误的统一映射：409 + 机器可读 code（不是 500——票在，状态不对） */
function stateError(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof InvoiceStateError) {
    return c.json({ error: err.code }, 409);
  }
  throw err;
}
