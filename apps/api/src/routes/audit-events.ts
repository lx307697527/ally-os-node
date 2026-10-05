import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";
import { requirePermission } from "../authz/middleware.ts";

/**
 * 审计日志查询端点（#29）。老系统对应物是 /admin/audit-logs 页面对审计表的
 * PostgREST 直读——新系统里审计行的写入收敛在应用层（audit/audit-log.ts），
 * 读取收敛在这里：`audit.read` 权限点门（owner/admin 默认持有），其余角色
 * 403。这是纯读端点：审计查询本身不写审计（读自己的操作史不是受监管动作，
 * 为每次翻页写一行只会让日志自我膨胀）。
 *
 * 分页是 offset + 精确 total：日志页按时间倒序翻页，页脚要有「共 N 条」
 * （老系统 FEAT-416 的裁定：分母是服务端的准确总数，不是本页行数）。
 */

/** 单页默认与上限：上限挡住「一次拖全表」的读法 */
export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 200;

const querySchema = z.object({
  limit: z.coerce.number().int().positive().max(AUDIT_PAGE_MAX).default(AUDIT_PAGE_DEFAULT),
  offset: z.coerce.number().int().nonnegative().default(0),
  /** 精确匹配过滤（发起了什么 / 对哪条记录）：日志页的定位需求，不做模糊搜索 */
  actor: z.string().trim().min(1).max(200).optional(),
  action: z.string().trim().min(1).max(200).optional(),
  target: z.string().trim().min(1).max(200).optional(),
});

export function auditEventsRoutes(deps: { db: Db }) {
  const app = new Hono<AppEnv>();
  const requireAuditRead = requirePermission("audit.read");

  app.get("/api/audit-events", requireAuditRead, async (c) => {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const { limit, offset, actor, action, target } = parsed.data;

    const filters: SQL[] = [];
    if (actor !== undefined) filters.push(eq(schema.auditEvents.actor, actor));
    if (action !== undefined) filters.push(eq(schema.auditEvents.action, action));
    if (target !== undefined) filters.push(eq(schema.auditEvents.target, target));
    const where = filters.length > 0 ? and(...filters) : undefined;

    const [rows, totals] = await Promise.all([
      deps.db
        .select({
          id: schema.auditEvents.id,
          actor: schema.auditEvents.actor,
          action: schema.auditEvents.action,
          target: schema.auditEvents.target,
          detail: schema.auditEvents.detail,
          createdAt: schema.auditEvents.createdAt,
        })
        .from(schema.auditEvents)
        .where(where)
        .orderBy(desc(schema.auditEvents.createdAt), desc(schema.auditEvents.id))
        .limit(limit)
        .offset(offset),
      deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.auditEvents)
        .where(where),
    ]);

    return c.json({
      events: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      total: totals[0]?.n ?? 0,
    });
  });

  return app;
}
