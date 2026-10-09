import { and, desc, eq, gte, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";
import { requirePermission } from "../authz/middleware.ts";

/**
 * 限流拒绝台账的读面（#27 切片 2）：被拦请求的管理可见面——验收第 3 条
 * 「管理页面能查看被拦截的请求」的 API 半边，老系统 /admin/rate-limits 的
 * 后继。`audit.read` 权限点门（owner/admin 默认持有），与审计日志、错误
 * 事件、删除台账同一扇门：都是运维/安全遥测，不是业务数据。
 *
 * 纯读端点：查台账不写审计（audit-events 同裁，读遥测不是受监管动作）。
 * 台账本身是遥测不是闸门（#27 切片 1 裁决 4）——429 的权威在计数器，这里
 * 只回答「谁在撞、撞什么、撞多狠」。
 */

/** 单页默认与上限：上限挡住「一次拖全表」的读法（audit-events 同值） */
export const RATE_LIMIT_DENIALS_PAGE_DEFAULT = 50;
export const RATE_LIMIT_DENIALS_PAGE_MAX = 200;

/** 汇总窗口默认与上限：按天回看，上限挡住无界聚合（error-events 同值） */
export const RATE_LIMIT_SUMMARY_DAYS_DEFAULT = 7;
export const RATE_LIMIT_SUMMARY_DAYS_MAX = 30;
export const RATE_LIMIT_SUMMARY_LIMIT_DEFAULT = 20;
export const RATE_LIMIT_SUMMARY_LIMIT_MAX = 100;

const listSchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(RATE_LIMIT_DENIALS_PAGE_MAX)
    .default(RATE_LIMIT_DENIALS_PAGE_DEFAULT),
  offset: z.coerce.number().int().nonnegative().default(0),
  /** 精确匹配过滤（哪个动作 / 哪个来源）：对账读法，不做模糊搜索 */
  action: z.string().trim().min(1).max(100).optional(),
  // 100 = 写入侧 IDENTIFIER_MAX_LENGTH 的同一截断边界
  identifier: z.string().trim().min(1).max(100).optional(),
});

const summarySchema = z.object({
  days: z.coerce.number().int().positive().max(RATE_LIMIT_SUMMARY_DAYS_MAX).default(RATE_LIMIT_SUMMARY_DAYS_DEFAULT),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(RATE_LIMIT_SUMMARY_LIMIT_MAX)
    .default(RATE_LIMIT_SUMMARY_LIMIT_DEFAULT),
});

export function rateLimitDenialsRoutes(deps: { db: Db }) {
  const app = new Hono<AppEnv>();
  const requireAuditRead = requirePermission("audit.read");

  // 动作汇总：分诊的第一屏——「最近谁在撞、撞什么动作」，与 error-events 的
  // 指纹汇总同形。distinct 来源数区分「一个人手滑」与「一个网段在扫」。
  app.get("/api/rate-limit-denials/summary", requireAuditRead, async (c) => {
    const parsed = summarySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const { days, limit } = parsed.data;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await deps.db
      .select({
        action: schema.rateLimitDenials.action,
        count: sql<number>`count(*)::int`,
        distinctIdentifiers: sql<number>`count(distinct ${schema.rateLimitDenials.identifier})::int`,
        lastDeniedAt: sql<Date>`max(${schema.rateLimitDenials.deniedAt})`,
      })
      .from(schema.rateLimitDenials)
      .where(gte(schema.rateLimitDenials.deniedAt, since))
      .groupBy(schema.rateLimitDenials.action)
      .orderBy(desc(sql`count(*)`), desc(sql`max(${schema.rateLimitDenials.deniedAt})`))
      .limit(limit);

    return c.json({
      windowDays: days,
      groups: rows.map((row) => ({
        action: row.action,
        count: row.count,
        distinctIdentifiers: row.distinctIdentifiers,
        lastDeniedAt: new Date(row.lastDeniedAt).toISOString(),
      })),
    });
  });

  app.get("/api/rate-limit-denials", requireAuditRead, async (c) => {
    const parsed = listSchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const { limit, offset, action, identifier } = parsed.data;

    const filters: SQL[] = [];
    if (action !== undefined) filters.push(eq(schema.rateLimitDenials.action, action));
    if (identifier !== undefined) filters.push(eq(schema.rateLimitDenials.identifier, identifier));
    const where = filters.length > 0 ? and(...filters) : undefined;

    const [rows, totals] = await Promise.all([
      deps.db
        .select({
          id: schema.rateLimitDenials.id,
          identifierType: schema.rateLimitDenials.identifierType,
          identifier: schema.rateLimitDenials.identifier,
          action: schema.rateLimitDenials.action,
          windowStart: schema.rateLimitDenials.windowStart,
          countAtDenial: schema.rateLimitDenials.countAtDenial,
          limitValue: schema.rateLimitDenials.limitValue,
          requestId: schema.rateLimitDenials.requestId,
          deniedAt: schema.rateLimitDenials.deniedAt,
        })
        .from(schema.rateLimitDenials)
        .where(where)
        .orderBy(desc(schema.rateLimitDenials.deniedAt), desc(schema.rateLimitDenials.id))
        .limit(limit)
        .offset(offset),
      deps.db.select({ n: sql<number>`count(*)::int` }).from(schema.rateLimitDenials).where(where),
    ]);

    return c.json({
      denials: rows.map((row) => ({
        ...row,
        windowStart: row.windowStart.toISOString(),
        deniedAt: row.deniedAt.toISOString(),
      })),
      total: totals[0]?.n ?? 0,
    });
  });

  return app;
}
