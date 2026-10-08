import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Db } from "@ally/db";
import { createInvoicePlan, getInvoicePlan, PLAN_PARTS_MAX, PLAN_PARTS_MIN } from "../billing/installments.ts";
import { NoActiveRuleError } from "../numbering/service.ts";
import type { AppEnv } from "../auth/session.ts";
import { requirePermission } from "../authz/middleware.ts";
import { recordAudit } from "../audit/audit-log.ts";

/**
 * 分期拆票端点（#192 分期切片：一个约定总额切成 n 张草稿票）。
 *
 * 全部在 `invoices.manage` 权限点后面（拆票与发票是同一道财务闸；分期票自己
 * 的 confirm/void/收款动词在发票与收款端点，零新动词）：
 *
 * - **POST /api/invoice-plans**：一次把约定总额切成 n 期（2–12）——计划行 +
 *   n 张 `installment` 类型单行草稿票在同一个事务里生灭（第 3 期发号失败则
 *   整个计划从未存在）。每期金额是整数分、必为正；合计（= 计划的约定拆分额）
 *   由服务端盖章，body 里没有「总额」字段（RULE-007：约定额是切出来的结果）。
 * - **GET /api/invoice-plans/:id**：计划台账——约定额、逐期钱态（与发票读写
 *   面同一条付款态算术）、在世口径合计与 uninvoicedCents（>0 有期未开/作废、
 *   <0 成员被改到超过约定，两种漂移都原样暴露）。
 *
 * subject 成对可选（invoices.subject 同裁，多态开集）：订单域 #231 进场后，
 * 按比例拆期的触发点走 billing/installments.ts 的 createInvoicePlan 服务接缝，
 * 不走 HTTP——与发票内核的属主域接缝同裁。
 */

const MAX_PLAN_TOTAL_CENTS = 2_147_483_647; // int4 上限：计划约定额的存储边界

const createBody = z
  .object({
    label: z.string().trim().min(1).max(200),
    subjectType: z.string().trim().min(1).max(64).optional(),
    subjectId: z.uuid().optional(),
    parts: z
      .array(z.object({ amountCents: z.number().int().positive().max(2_000_000_000) }))
      .min(PLAN_PARTS_MIN)
      .max(PLAN_PARTS_MAX),
  })
  .refine(
    (body) => (body.subjectType === undefined) === (body.subjectId === undefined),
    "subjectType and subjectId must be provided together",
  )
  .refine(
    (body) => body.parts.reduce((sum, part) => sum + part.amountCents, 0) <= MAX_PLAN_TOTAL_CENTS,
    "plan total exceeds the stored limit",
  );

export function invoicePlansRoutes(deps: { db: Db; logger: Logger }) {
  const app = new Hono<AppEnv>();
  const requireInvoicesManage = requirePermission("invoices.manage");

  app.post("/api/invoice-plans", requireInvoicesManage, async (c) => {
    const parsed = createBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const body = parsed.data;
    const actorId = c.get("user").id;
    const input = {
      label: body.label,
      ...(body.subjectType !== undefined && body.subjectId !== undefined
        ? { subject: { type: body.subjectType, id: body.subjectId } }
        : {}),
      parts: body.parts,
      createdById: actorId,
    };
    let created: Awaited<ReturnType<typeof createInvoicePlan>>;
    try {
      created = await deps.db.transaction(async (tx) => createInvoicePlan(tx, input));
    } catch (err) {
      // 没有编号的单据不存在：任一期的发号失败回滚整个计划（fail closed，
      // 与发票/贷项单同一先例——修复动作是去配置工作室建生效规则）
      if (err instanceof NoActiveRuleError) {
        return c.json({ error: "numbering_not_configured" }, 409);
      }
      throw err;
    }
    await recordAudit(deps.db, {
      actor: actorId,
      action: "invoice_plan.created",
      target: created.id,
      detail: {
        label: created.label,
        totalCents: created.totalCents,
        partCount: created.parts.length,
        partNumbers: created.parts.map((part) => part.number),
        ...(input.subject !== undefined
          ? { subjectType: input.subject.type, subjectId: input.subject.id }
          : {}),
      },
    });
    return c.json(
      {
        id: created.id,
        totalCents: created.totalCents,
        parts: created.parts.map((part) => ({
          id: part.id,
          number: part.number,
          planIndex: part.planIndex,
          amountCents: part.amountCents,
        })),
      },
      201,
    );
  });

  app.get("/api/invoice-plans/:id", requireInvoicesManage, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const plan = await getInvoicePlan(deps.db, id.data);
    if (plan === null) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json(plan);
  });

  return app;
}
