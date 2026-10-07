import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";
import { requirePermission } from "../authz/middleware.ts";
import { recordAudit } from "../audit/audit-log.ts";
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
    issuedAt: Date | null;
    voidedAt: Date | null;
    voidReason: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  totalCents: number,
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
    totalCents,
    issuedAt: row.issuedAt,
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

export function invoicesRoutes(deps: { db: Db; logger: Logger }) {
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
    const rows = await deps.db
      .select()
      .from(schema.invoices)
      .where(where)
      .orderBy(asc(schema.invoices.createdAt));
    const withTotals = await Promise.all(
      rows.map(async (row) => presentInvoice(row, await sumLineTotals(deps.db, row.id))),
    );
    return c.json({ invoices: withTotals });
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
    return c.json(presentInvoice(row, totalCents, lines));
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
    const actorId = c.get("user").id;
    let confirmed: { outcome: "issued" | "already" | null; number: string; totalCents: number };
    try {
      confirmed = await deps.db.transaction(async (tx) => {
        const result = await confirmInvoice(tx, id.data, actorId);
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
    if (confirmed.outcome === null) {
      return c.json({ error: "not_found" }, 404);
    }
    if (confirmed.outcome === "issued") {
      await recordAudit(deps.db, {
        actor: actorId,
        action: "invoice.confirmed",
        target: id.data,
        detail: { number: confirmed.number, totalCents: confirmed.totalCents },
      });
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

  return app;
}

/** 状态机错误的统一映射：409 + 机器可读 code（不是 500——票在，状态不对） */
function stateError(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof InvoiceStateError) {
    return c.json({ error: err.code }, 409);
  }
  throw err;
}
