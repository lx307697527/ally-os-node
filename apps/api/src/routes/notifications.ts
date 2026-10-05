import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";

/**
 * 站内通知的读取与已读端点（#129）。老系统对应物是 PostgREST 直读
 * platform.notifications + 两个已读 RPC——新系统里读写都走这里：
 * 铃铛一次请求拿「最近 + 未读数」（FEAT-391 的单读合同），已读只允许
 * 操作自己的行。
 *
 * 写入方（谁创建通知）不在这个文件：老系统是 outbox 触发器按 event_type
 * 白名单扇出，本系统的扇出生产者随各业务域迁移时落地，届时补幂等键列
 * （expand-only）。
 */

/** 铃铛下拉一次带走的行数，与前端常量是等价性契约（老 20 行字面量）。 */
export const BELL_RECENT_LIMIT = 20;

/**
 * 未读数返回 min(实际, 21)：21 不是真实计数，是「超过 20」的哨兵——
 * 角标只打印 "20+"，为它数出精确总数是白花的查询（老系统的裁定）。
 */
export const UNREAD_COUNT_CAP = 21;

const notificationIdSchema = z.uuid();

export function notificationsRoutes(deps: { db: Db }) {
  const app = new Hono<AppEnv>();

  app.get("/api/notifications/summary", async (c) => {
    const userId = c.get("user").id;
    // 两个读都带 userId 过滤——数据按行属于本人，越权行根本不进结果集
    const [recent, unread] = await Promise.all([
      deps.db
        .select({
          id: schema.notifications.id,
          eventType: schema.notifications.eventType,
          aggregateType: schema.notifications.aggregateType,
          aggregateId: schema.notifications.aggregateId,
          payload: schema.notifications.payload,
          isRead: schema.notifications.isRead,
          createdAt: schema.notifications.createdAt,
        })
        .from(schema.notifications)
        .where(eq(schema.notifications.userId, userId))
        .orderBy(desc(schema.notifications.createdAt), desc(schema.notifications.id))
        .limit(BELL_RECENT_LIMIT),
      deps.db
        .select({ n: schema.notifications.id })
        .from(schema.notifications)
        .where(and(eq(schema.notifications.userId, userId), eq(schema.notifications.isRead, false)))
        .limit(UNREAD_COUNT_CAP),
    ]);
    return c.json({
      recent: recent.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      unreadCount: unread.length,
    });
  });

  app.post("/api/notifications/:id/read", async (c) => {
    const parsed = notificationIdSchema.safeParse(c.req.param("id"));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    // 别人的通知 id 静默 no-op（老 RPC 的反探测裁定）：不区分「不存在」与
    // 「不是你的」，两种情况都是 200 空体，调用方拿不到探测结论。
    const updated = await deps.db
      .update(schema.notifications)
      .set({ isRead: true, readAt: new Date() })
      .where(
        and(
          eq(schema.notifications.id, parsed.data),
          eq(schema.notifications.userId, c.get("user").id),
        ),
      )
      .returning({ id: schema.notifications.id });
    return c.json({ marked: updated.length });
  });

  app.post("/api/notifications/read-all", async (c) => {
    const updated = await deps.db
      .update(schema.notifications)
      .set({ isRead: true, readAt: new Date() })
      .where(
        and(
          eq(schema.notifications.userId, c.get("user").id),
          eq(schema.notifications.isRead, false),
        ),
      )
      .returning({ id: schema.notifications.id });
    return c.json({ marked: updated.length });
  });

  return app;
}
