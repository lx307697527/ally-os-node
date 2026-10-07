import { Hono } from "hono";
import type { Context } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Db } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";
import { requirePermission } from "../authz/middleware.ts";
import { recordAudit } from "../audit/audit-log.ts";
import {
  listPaymentsForInvoice,
  PAYMENT_METHODS,
  PaymentExistsError,
  PaymentStateError,
  recordPayment,
  voidPayment,
} from "../billing/payments.ts";

/**
 * 收款端点（#192 切片 2：收款台账的财务面）。
 *
 * 全部在 `invoices.manage` 权限点后面（finance/owner 默认持有——#232 §12 财务
 * 「认领收款」；跨票的收款总览/待认领银行流水随 #181 进场，这里只有发票锚定
 * 的记账面）。#193 的 webhook 不走 HTTP 面：验签 + 规范化后在自己的业务事务
 * 里调 billing/payments.ts 的 recordPayment，传 source 幂等键——重放对 webhook
 * 是「已记账成功」（吃掉 PaymentExistsError 回 2xx），对这里的财务面是 409。
 *
 * 到账不推进发票状态（R-12-6 财务确认是人的闸门，老系统 record_payment_atomic
 * 的 draft 自动跳 sent 被刻意抛弃）：draft/void 票记账 409 fail closed，状态
 * 门语义见 billing/payments.ts 文件头。付款态是派生值，paymentStatus/paidCents
 * 随每个读法实时给出。
 */

const MAX_AMOUNT_CENTS = 2_147_483_647; // int4 上限：amount_cents 的存储边界

const recordBody = z
  .object({
    amountCents: z.number().int().positive().max(MAX_AMOUNT_CENTS),
    method: z.enum(PAYMENT_METHODS),
    // 钱实际到账的时刻（电汇可能是昨天到的）；不许未来——到账是过去的事实
    receivedAt: z.iso.datetime().optional(),
    note: z.string().trim().min(1).max(500).optional(),
    sourceType: z.string().trim().min(1).max(64).optional(),
    sourceKey: z.string().trim().min(1).max(200).optional(),
  })
  .refine(
    (body) => (body.sourceType === undefined) === (body.sourceKey === undefined),
    "sourceType and sourceKey must be provided together",
  );

const voidBody = z.object({ reason: z.string().trim().min(1).max(500) });

export function paymentsRoutes(deps: { db: Db; logger: Logger }) {
  const app = new Hono<AppEnv>();
  const requireInvoicesManage = requirePermission("invoices.manage");

  app.post("/api/invoices/:id/payments", requireInvoicesManage, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const parsed = recordBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const body = parsed.data;
    const actorId = c.get("user").id;
    const receivedAt = body.receivedAt !== undefined ? new Date(body.receivedAt) : new Date();
    if (receivedAt.getTime() > Date.now()) {
      return c.json({ error: "invalid_request" }, 400);
    }
    let recorded:
      | { id: string; number: string; totalCents: number; paidCents: number; paymentStatus: string }
      | null;
    try {
      recorded = await deps.db.transaction(async (tx) =>
        recordPayment(tx, id.data, {
          amountCents: body.amountCents,
          method: body.method,
          receivedAt,
          note: body.note ?? null,
          ...(body.sourceType !== undefined && body.sourceKey !== undefined
            ? { source: { type: body.sourceType, key: body.sourceKey } }
            : {}),
          recordedById: actorId,
        }),
      );
    } catch (err) {
      return paymentError(c, err);
    }
    if (recorded === null) {
      return c.json({ error: "not_found" }, 404);
    }
    await recordAudit(deps.db, {
      actor: actorId,
      action: "payment.recorded",
      target: recorded.id,
      detail: {
        invoiceId: id.data,
        invoiceNumber: recorded.number,
        amountCents: body.amountCents,
        method: body.method,
        paymentStatus: recorded.paymentStatus,
        paidCents: recorded.paidCents,
        totalCents: recorded.totalCents,
        ...(body.sourceType !== undefined && body.sourceKey !== undefined
          ? { sourceType: body.sourceType, sourceKey: body.sourceKey }
          : {}),
      },
    });
    return c.json(
      {
        id: recorded.id,
        paidCents: recorded.paidCents,
        totalCents: recorded.totalCents,
        paymentStatus: recorded.paymentStatus,
      },
      201,
    );
  });

  app.get("/api/invoices/:id/payments", requireInvoicesManage, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const ledger = await listPaymentsForInvoice(deps.db, id.data);
    if (ledger === null) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json(ledger);
  });

  app.post("/api/payments/:id/void", requireInvoicesManage, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const parsed = voidBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const actorId = c.get("user").id;
    let voided:
      | {
          outcome: "voided" | "already";
          invoiceId: string;
          number: string;
          amountCents: number;
          method: string;
          paidCents: number;
          paymentStatus: string;
        }
      | null;
    try {
      voided = await deps.db.transaction(async (tx) =>
        voidPayment(tx, id.data, actorId, parsed.data.reason),
      );
    } catch (err) {
      return paymentError(c, err);
    }
    if (voided === null) {
      return c.json({ error: "not_found" }, 404);
    }
    if (voided.outcome === "voided") {
      await recordAudit(deps.db, {
        actor: actorId,
        action: "payment.voided",
        target: id.data,
        detail: {
          invoiceId: voided.invoiceId,
          invoiceNumber: voided.number,
          amountCents: voided.amountCents,
          method: voided.method,
          paymentStatus: voided.paymentStatus,
          paidCents: voided.paidCents,
          reason: parsed.data.reason,
        },
      });
    }
    return c.json({ status: voided.outcome, paidCents: voided.paidCents, paymentStatus: voided.paymentStatus });
  });

  return app;
}

/** 状态/幂等错误的统一映射：409 + 机器可读 code（票/款在，状态不对） */
function paymentError(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof PaymentStateError) {
    return c.json({ error: err.code }, 409);
  }
  if (err instanceof PaymentExistsError) {
    return c.json({ error: err.code }, 409);
  }
  throw err;
}
