import { eq } from "drizzle-orm";
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
  type CreateCreditNoteInput,
  CreditNoteExceedsInvoiceError,
  CreditNoteStateError,
  confirmCreditNote,
  createCreditNote,
  getCreditNote,
  listCreditNotesForInvoice,
  voidCreditNote,
} from "../billing/credits.ts";
import { NoActiveRuleError } from "../numbering/service.ts";

/**
 * 贷项单端点（#192 红冲切片：issued 票的更正动词）。
 *
 * 全部在 `invoices.manage` 权限点后面（贷项单与发票是同一道财务闸，R-12-6）。
 * 动词家族与发票路由同构：
 *
 * - **POST /api/invoices/:id/credit-notes**：对 issued 票开贷项草稿（当前唯一
 *   入口是财务手工创建；#239 触发域进场时走 billing/credits.ts 的服务接缝，
 *   与发票内核的属主域接缝同裁）。冲抵边界（有效贷项 ≤ 原票合计）在服务层
 *   的发票行锁内校验，超界 409 credit_exceeds_invoice。
 * - **POST …/confirm、POST …/void**：draft → issued（R-12-6 财务确认，冲抵
 *   自此计入有效应付）/ draft → void；issued 贷项单是终态（not_voidable）。
 *   重复动词幂等返回现状，不落审计。
 * - **GET /api/invoices/:id/credit-notes、GET /api/credit-notes/:id**：台账与
 *   详情读法（贷项动作 web 面的接缝）。
 *
 * 金额纪律与发票同款：quantity 三位小数、单价整数分、行合计是 DB 生成列，
 * 客户端只提交数量与单价（RULE-007）。空单不存在（lines 至少一行，老 bug500
 * 在创建面收口的同一裁决）；reason 必填——贷项单是更正的叙事本体。
 */

// 三位小数与行合计边界：发票路由 lineInput 的同款收口（浮点直判会被表示误差
// 误伤，走十进制字符串往返）
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

const createBody = z.object({
  reason: z.string().trim().min(1).max(500),
  lines: z.array(lineInput).min(1).max(200),
});

const voidBody = z.object({ reason: z.string().trim().min(1).max(500).optional() });

export function creditNotesRoutes(deps: { db: Db; logger: Logger }) {
  const app = new Hono<AppEnv>();
  const requireInvoicesManage = requirePermission("invoices.manage");

  app.post("/api/invoices/:id/credit-notes", requireInvoicesManage, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const parsed = createBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const actorId = c.get("user").id;
    const input: CreateCreditNoteInput = {
      invoiceId: id.data,
      reason: parsed.data.reason,
      lines: parsed.data.lines,
      createdById: actorId,
    };
    let created: { id: string; number: string; invoiceNumber: string; creditedCents: number };
    try {
      created = await deps.db.transaction(async (tx) => {
        const result = await createCreditNote(tx, input);
        if (result === null) {
          return { id: "", number: "", invoiceNumber: "", creditedCents: 0 };
        }
        const header = await tx
          .select({ number: schema.invoices.number })
          .from(schema.invoices)
          .where(eq(schema.invoices.id, id.data))
          .limit(1);
        return {
          ...result,
          invoiceNumber: header[0]?.number ?? "",
        };
      });
    } catch (err) {
      return creditError(c, err);
    }
    if (created.id === "") {
      return c.json({ error: "not_found" }, 404);
    }
    await recordAudit(deps.db, {
      actor: actorId,
      action: "credit_note.created",
      target: created.id,
      detail: {
        number: created.number,
        invoiceId: id.data,
        invoiceNumber: created.invoiceNumber,
        lineCount: parsed.data.lines.length,
        creditedCents: created.creditedCents,
      },
    });
    return c.json({ id: created.id, number: created.number }, 201);
  });

  app.get("/api/invoices/:id/credit-notes", requireInvoicesManage, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const ledger = await listCreditNotesForInvoice(deps.db, id.data);
    if (ledger === null) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({
      creditedCents: ledger.creditedCents,
      creditNotes: ledger.creditNotes,
    });
  });

  app.get("/api/credit-notes/:id", requireInvoicesManage, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const note = await getCreditNote(deps.db, id.data);
    if (note === null) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json(note);
  });

  app.post("/api/credit-notes/:id/confirm", requireInvoicesManage, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    // body 可省（确认无必填字段）——无 body 的 POST 也是合法请求
    await c.req.json().catch(() => undefined);
    const actorId = c.get("user").id;
    let confirmed: {
      outcome: "issued" | "already" | null;
      invoiceNumber: string;
      number: string;
      creditedCents: number;
    };
    try {
      confirmed = await deps.db.transaction(async (tx) => {
        const result = await confirmCreditNote(tx, id.data, actorId);
        return (
          result ?? { outcome: null, invoiceNumber: "", number: "", creditedCents: 0 }
        );
      });
    } catch (err) {
      return creditError(c, err);
    }
    if (confirmed.outcome === null) {
      return c.json({ error: "not_found" }, 404);
    }
    if (confirmed.outcome === "issued") {
      await recordAudit(deps.db, {
        actor: actorId,
        action: "credit_note.confirmed",
        target: id.data,
        detail: {
          number: confirmed.number,
          invoiceNumber: confirmed.invoiceNumber,
          creditedCents: confirmed.creditedCents,
        },
      });
    }
    return c.json({ status: confirmed.outcome });
  });

  app.post("/api/credit-notes/:id/void", requireInvoicesManage, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const parsed = voidBody.safeParse((await c.req.json().catch(() => undefined)) ?? {});
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const actorId = c.get("user").id;
    let voided: {
      outcome: "voided" | "already" | null;
      invoiceNumber: string;
      number: string;
      creditedCents: number;
    };
    try {
      voided = await deps.db.transaction(async (tx) => {
        const result = await voidCreditNote(tx, id.data, actorId, parsed.data.reason ?? null);
        return (
          result ?? { outcome: null, invoiceNumber: "", number: "", creditedCents: 0 }
        );
      });
    } catch (err) {
      return creditError(c, err);
    }
    if (voided.outcome === null) {
      return c.json({ error: "not_found" }, 404);
    }
    if (voided.outcome === "voided") {
      await recordAudit(deps.db, {
        actor: actorId,
        action: "credit_note.voided",
        target: id.data,
        detail: {
          number: voided.number,
          invoiceNumber: voided.invoiceNumber,
          creditedCents: voided.creditedCents,
          ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
        },
      });
    }
    return c.json({ status: voided.outcome });
  });

  return app;
}

/**
 * 贷项单错误的统一映射：409 + 机器可读 code（不是 500——单据在，状态不对）。
 * numbering_not_configured 与发票面同一先例：没有编号的单据不存在，fail
 * closed 映射成可操作的失败（去配置工作室建生效规则）。
 */
function creditError(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof CreditNoteStateError) {
    return c.json({ error: err.code }, 409);
  }
  if (err instanceof CreditNoteExceedsInvoiceError) {
    return c.json({ error: err.code }, 409);
  }
  if (err instanceof NoActiveRuleError) {
    return c.json({ error: "numbering_not_configured" }, 409);
  }
  throw err;
}
