import { and, desc, eq, gte, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";
import { requirePermission } from "../authz/middleware.ts";

/**
 * 错误事件的读面（#28 切片 1）：前后端错误进同一张表（web 走公开上报端点、
 * api 走 onError 捕获），这里就是「同一个地方查看」的那个地方——老系统
 * /admin/error-logs 的后继。`audit.read` 权限点门（owner/admin 默认持有），
 * 与审计日志、删除台账同一扇门：都是运维/安全遥测，不是业务数据。
 *
 * 纯读端点：查询错误不写审计（与 audit-events 同裁，读遥测不是受监管动作）。
 */

/** 单页默认与上限：上限挡住「一次拖全表」的读法（audit-events 同值） */
export const ERROR_EVENTS_PAGE_DEFAULT = 50;
export const ERROR_EVENTS_PAGE_MAX = 200;

/** 汇总窗口默认与上限：按天回看，上限挡住无界聚合 */
export const ERROR_SUMMARY_DAYS_DEFAULT = 7;
export const ERROR_SUMMARY_DAYS_MAX = 30;
export const ERROR_SUMMARY_LIMIT_DEFAULT = 20;
export const ERROR_SUMMARY_LIMIT_MAX = 100;

const listSchema = z.object({
  limit: z.coerce.number().int().positive().max(ERROR_EVENTS_PAGE_MAX).default(ERROR_EVENTS_PAGE_DEFAULT),
  offset: z.coerce.number().int().nonnegative().default(0),
  fingerprint: z.string().trim().min(1).max(64).optional(),
  source: z.enum(["web", "api"]).optional(),
});

const summarySchema = z.object({
  days: z.coerce.number().int().positive().max(ERROR_SUMMARY_DAYS_MAX).default(ERROR_SUMMARY_DAYS_DEFAULT),
  limit: z.coerce.number().int().positive().max(ERROR_SUMMARY_LIMIT_MAX).default(ERROR_SUMMARY_LIMIT_DEFAULT),
});

export function errorEventsRoutes(deps: { db: Db }) {
  const app = new Hono<AppEnv>();
  const requireAuditRead = requirePermission("audit.read");

  // 指纹汇总：分诊的第一屏——「最近哪种错误最多」，点进指纹再翻明细
  app.get("/api/error-events/summary", requireAuditRead, async (c) => {
    const parsed = summarySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const { days, limit } = parsed.data;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await deps.db
      .select({
        fingerprint: schema.errorEvents.fingerprint,
        source: schema.errorEvents.source,
        count: sql<number>`count(*)::int`,
        firstSeen: sql<Date>`min(${schema.errorEvents.createdAt})`,
        lastSeen: sql<Date>`max(${schema.errorEvents.createdAt})`,
        // 最近一条 message 当样本：分组行的自描述，省一次回表
        sampleMessage: sql<string>`(array_agg(${schema.errorEvents.message} order by ${schema.errorEvents.createdAt} desc))[1]`,
      })
      .from(schema.errorEvents)
      .where(gte(schema.errorEvents.createdAt, since))
      .groupBy(schema.errorEvents.fingerprint, schema.errorEvents.source)
      .orderBy(desc(sql`count(*)`), desc(sql`max(${schema.errorEvents.createdAt})`))
      .limit(limit);

    return c.json({
      windowDays: days,
      groups: rows.map((row) => ({
        fingerprint: row.fingerprint,
        source: row.source,
        count: row.count,
        firstSeen: new Date(row.firstSeen).toISOString(),
        lastSeen: new Date(row.lastSeen).toISOString(),
        sampleMessage: row.sampleMessage,
      })),
    });
  });

  app.get("/api/error-events", requireAuditRead, async (c) => {
    const parsed = listSchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const { limit, offset, fingerprint, source } = parsed.data;

    const filters: SQL[] = [];
    if (fingerprint !== undefined) filters.push(eq(schema.errorEvents.fingerprint, fingerprint));
    if (source !== undefined) filters.push(eq(schema.errorEvents.source, source));
    const where = filters.length > 0 ? and(...filters) : undefined;

    const [rows, totals] = await Promise.all([
      deps.db
        .select({
          id: schema.errorEvents.id,
          fingerprint: schema.errorEvents.fingerprint,
          source: schema.errorEvents.source,
          message: schema.errorEvents.message,
          stack: schema.errorEvents.stack,
          url: schema.errorEvents.url,
          userAgent: schema.errorEvents.userAgent,
          requestId: schema.errorEvents.requestId,
          createdAt: schema.errorEvents.createdAt,
        })
        .from(schema.errorEvents)
        .where(where)
        .orderBy(desc(schema.errorEvents.createdAt), desc(schema.errorEvents.id))
        .limit(limit)
        .offset(offset),
      deps.db.select({ n: sql<number>`count(*)::int` }).from(schema.errorEvents).where(where),
    ]);

    return c.json({
      events: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      total: totals[0]?.n ?? 0,
    });
  });

  return app;
}
